'use strict';

import { createHash } from 'crypto';
import { ManagedSshMachine, MaterializedManagedRemoteCatalog } from './types';

/** Stable catalog reference, carried by the existing ProxyJump field. */
export function managedJumpAlias(machineId: string): string {
    return `agent-pivot-${createHash('sha256').update(machineId).digest('hex').slice(0, 32)}`;
}

export function managedJumpRoute(catalog: MaterializedManagedRemoteCatalog, machine: ManagedSshMachine): ManagedSshMachine[] {
    const byAlias = new Map(catalog.machines.map(value => [managedJumpAlias(value.id), value]));
    const visiting = new Set<string>([machine.id]);
    const result: ManagedSshMachine[] = [];
    function visit(current: ManagedSshMachine): void {
        for (const alias of (current.connection.proxyJump || '').split(',').filter(Boolean)) {
            if (!/^agent-pivot-[a-f0-9]{32}$/u.test(alias)) { continue; }
            const hop = byAlias.get(alias);
            if (!hop) { throw new Error(`A jump host for ${current.name} is missing. Restore or change its connection.`); }
            if (hop.connection.sshConfigAlias) { throw new Error(`Jump host ${hop.name} references local SSH configuration. Convert it to a synced connection first.`); }
            if (visiting.has(hop.id) || visiting.size > 8) { throw new Error('The jump route contains a cycle or exceeds eight hops.'); }
            if (catalog.conflicts.some(conflict => conflict.entityType === 'machine' && conflict.entityId === hop.id)) {
                throw new Error(`Jump host ${hop.name} has a sync conflict. Review it before connecting.`);
            }
            visiting.add(hop.id);
            visit(hop);
            visiting.delete(hop.id);
            if (result.length >= 8 || result.some(value => value.id === hop.id)) { throw new Error('The jump route repeats a host or exceeds eight hops.'); }
            result.push(hop);
        }
    }
    visit(machine);
    return result;
}

export function jumpHostIds(machines: ManagedSshMachine[]): Set<string> {
    const referenced = new Set(machines.reduce<string[]>((values, machine) => values.concat((machine.connection.proxyJump || '').split(',')), []));
    return new Set(machines.filter(machine => referenced.has(managedJumpAlias(machine.id))).map(machine => machine.id));
}
