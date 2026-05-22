
export const BASH_PERMISSION_REQUESTED : string = "pibusiness:bash_permission_requested";
export const BASH_PERMISSION_RESPONSE : string = "pibusiness:bash_permission_response";

export const QUESTION_REQUESTED : string = "pibusiness:question_requested";
export const QUESTION_RESPONSE : string = "pibusiness:question_response";

export interface BashPermissionRequestedEvent {
    requestId: string;
    command: string;
}

export interface BashPermissionResponseEvent {
    requestId: string;
    allowed: boolean;
    reason?: string;
}

export interface QuestionRequestedEvent {
    requestId: string;
    question: string;
    options: string[];
    allowCustomAnswer: boolean;
}

export interface QuestionResponseEvent {
    requestId: string;
    answer: string | null;
    cancelled: boolean;
}