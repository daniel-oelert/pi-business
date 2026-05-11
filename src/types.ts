
export const BASH_PERMISSION_REQUESTED : string = "pibusiness:bash_permission_requested";
export const BASH_PERMISSION_RESPONSE : string = "pibusiness:bash_permission_response";

export interface BashPermissionRequestedEvent {
    requestId: string;
    command: string;
}

export interface BashPermissionResponseEvent {
    requestId: string;
    allowed: boolean;
    reason?: string;
}