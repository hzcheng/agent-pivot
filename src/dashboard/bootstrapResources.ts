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
        this.assertOwnable();
        this.disposables.push(disposable);
        return disposable;
    }

    assertActive(): void {
        if (this.state === 'disposed') {
            throw new Error(DISPOSED_ERROR_MESSAGE);
        }
    }

    transferTo(target: DashboardBootstrapDisposable[]): void {
        this.assertOwnable();
        target.push(...this.disposables);
        target.push({
            dispose: () => this.dispose(),
        });
        this.disposables.length = 0;
        this.state = 'transferred';
    }

    dispose(): void {
        if (this.state === 'disposed') {
            return;
        }

        const ownsDisposables = this.state === 'active';
        this.state = 'disposed';
        if (!ownsDisposables) {
            return;
        }
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

    private assertOwnable(): void {
        this.assertActive();
        if (this.state === 'transferred') {
            throw new Error(TRANSFERRED_ERROR_MESSAGE);
        }
    }
}
