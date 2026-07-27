'use strict';

export interface DashboardBootstrapDisposable {
    dispose(): unknown;
}

type ResourceState = 'active' | 'transferred' | 'disposed';

const DISPOSED_ERROR_MESSAGE =
    'Dashboard bootstrap resources have already been disposed.';
const TRANSFERRED_ERROR_MESSAGE =
    'Dashboard bootstrap resources have already been transferred.';

export class DashboardBootstrapResources {
    private readonly disposables: DashboardBootstrapDisposable[] = [];
    private state: ResourceState = 'active';

    own<T extends DashboardBootstrapDisposable>(disposable: T): T {
        this.assertActive();
        this.disposables.push(disposable);
        return disposable;
    }

    assertActive(): void {
        if (this.state === 'disposed') {
            throw new Error(DISPOSED_ERROR_MESSAGE);
        }
        if (this.state === 'transferred') {
            throw new Error(TRANSFERRED_ERROR_MESSAGE);
        }
    }

    transferTo(target: DashboardBootstrapDisposable[]): void {
        this.assertActive();
        target.push(...this.disposables);
        this.disposables.length = 0;
        this.state = 'transferred';
    }

    dispose(): void {
        if (this.state !== 'active') {
            return;
        }

        this.state = 'disposed';
        let capturedError = false;
        let firstError: unknown;
        for (let index = this.disposables.length - 1; index >= 0; index--) {
            try {
                this.disposables[index].dispose();
            } catch (error) {
                if (!capturedError) {
                    capturedError = true;
                    firstError = error;
                }
            }
        }
        this.disposables.length = 0;
        if (capturedError) {
            throw firstError;
        }
    }
}
