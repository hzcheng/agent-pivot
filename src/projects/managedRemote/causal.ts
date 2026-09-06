'use strict';

import {
    CausalVersion,
    VersionedCandidate,
    VersionedCandidates,
    VersionVector,
} from './types';

export function cloneManagedValue<T>(value: T): T {
    if (value === null || value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value));
}

export function stableManagedValue(value: unknown): string {
    return JSON.stringify(sortManagedValue(value));
}

function sortManagedValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortManagedValue);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        result[key] = sortManagedValue((value as Record<string, unknown>)[key]);
    }
    return result;
}

export function normalizeVersionVector(vector: VersionVector): VersionVector {
    const result: VersionVector = {};
    for (const actorId of Object.keys(vector || {}).sort()) {
        const counter = vector[actorId];
        if (actorId && Number.isSafeInteger(counter) && counter >= 0) {
            result[actorId] = counter;
        }
    }
    return result;
}

export function joinVersionVectors(left: VersionVector, right: VersionVector): VersionVector {
    const result = normalizeVersionVector(left || {});
    for (const actorId of Object.keys(right || {})) {
        result[actorId] = Math.max(result[actorId] || 0, right[actorId] || 0);
    }
    return normalizeVersionVector(result);
}

export function versionVectorDominates(left: VersionVector, right: VersionVector): boolean {
    return Object.keys(right || {}).every(actorId =>
        (left?.[actorId] || 0) >= (right[actorId] || 0));
}

export function createCausalVersion(
    context: VersionVector,
    actorId: string,
    requestedCounter?: number,
): CausalVersion {
    if (!actorId) {
        throw new Error('Managed catalog actor ID is required.');
    }
    const normalizedContext = normalizeVersionVector(context || {});
    const counter = requestedCounter === undefined
        ? (normalizedContext[actorId] || 0) + 1
        : requestedCounter;
    if (!Number.isSafeInteger(counter) || counter <= (normalizedContext[actorId] || 0)) {
        throw new Error('Managed catalog counter must advance the actor context.');
    }
    return {
        dot: { actorId, counter },
        context: normalizedContext,
    };
}

export function vectorIncludingVersion(version: CausalVersion): VersionVector {
    const result = normalizeVersionVector(version.context);
    result[version.dot.actorId] = Math.max(
        result[version.dot.actorId] || 0,
        version.dot.counter,
    );
    return normalizeVersionVector(result);
}

export function versionObserves(left: CausalVersion, right: CausalVersion): boolean {
    return left.context[right.dot.actorId] >= right.dot.counter;
}

export function causalVersionKey(version: CausalVersion): string {
    return stableManagedValue({
        actorId: version.dot.actorId,
        counter: version.dot.counter,
        context: normalizeVersionVector(version.context),
    });
}

export function candidateKey<T>(candidate: VersionedCandidate<T>): string {
    return `${causalVersionKey(candidate.version)}:${stableManagedValue(candidate.value)}`;
}

export function normalizeVersionedCandidates<T>(
    register: VersionedCandidates<T>,
): VersionedCandidates<T> {
    if (!register || !Array.isArray(register.candidates) || !register.candidates.length) {
        throw new Error('Managed catalog register requires at least one candidate.');
    }

    const byDot = new Map<string, VersionedCandidate<T>>();
    for (const source of register.candidates) {
        const candidate: VersionedCandidate<T> = {
            value: cloneManagedValue(source.value),
            version: {
                dot: cloneManagedValue(source.version.dot),
                context: normalizeVersionVector(source.version.context),
            },
        };
        const dotKey = `${candidate.version.dot.actorId}:${candidate.version.dot.counter}`;
        const existing = byDot.get(dotKey);
        if (existing && candidateKey(existing) !== candidateKey(candidate)) {
            throw new Error(`Managed catalog dot ${dotKey} was reused for different values.`);
        }
        byDot.set(dotKey, candidate);
    }

    const candidates = Array.from(byDot.values());
    for (let left = 0; left < candidates.length; left += 1) {
        for (let right = left + 1; right < candidates.length; right += 1) {
            if (versionObserves(candidates[left].version, candidates[right].version)
                && versionObserves(candidates[right].version, candidates[left].version)) {
                throw new Error('Managed catalog contains an impossible causal cycle.');
            }
        }
    }
    const live = candidates.filter(candidate => !candidates.some(other =>
        other !== candidate && versionObserves(other.version, candidate.version)));
    live.sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
    return { candidates: live };
}

export function joinVersionedCandidates<T>(
    left: VersionedCandidates<T>,
    right: VersionedCandidates<T>,
): VersionedCandidates<T> {
    return normalizeVersionedCandidates({
        candidates: [
            ...cloneManagedValue(left.candidates),
            ...cloneManagedValue(right.candidates),
        ],
    });
}

export function createVersionedCandidates<T>(
    value: T,
    version: CausalVersion,
): VersionedCandidates<T> {
    return normalizeVersionedCandidates({ candidates: [{ value, version }] });
}

export function replaceVersionedCandidates<T>(
    value: T,
    version: CausalVersion,
): VersionedCandidates<T> {
    return createVersionedCandidates(value, version);
}

export function distinctCandidateValues<T>(register: VersionedCandidates<T>): T[] {
    const values = new Map<string, T>();
    for (const candidate of normalizeVersionedCandidates(register).candidates) {
        const key = stableManagedValue(candidate.value);
        if (!values.has(key)) {
            values.set(key, cloneManagedValue(candidate.value));
        }
    }
    return Array.from(values.values());
}
