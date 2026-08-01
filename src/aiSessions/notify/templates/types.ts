'use strict';

export interface NotifyRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}
