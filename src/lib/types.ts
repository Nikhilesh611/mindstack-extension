// ─────────────────────────────────────────────
// API Data Types
// ─────────────────────────────────────────────

export interface Project {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
}

export interface CaptureAttachment {
    id: string;
    s3_url: string;
    file_type: string;
    file_name: string;
}

export interface Capture {
    id: string;
    session_id: string;
    project_id: string;
    capture_type: CaptureType;
    priority: number;
    source_url: string | null;
    page_title: string | null;
    video_start_time: number | null;
    video_end_time: number | null;
    text_content: string | null;
    ai_markdown_summary: string | null;
    created_at: string;
    capture_attachments: CaptureAttachment[];
}

export interface PresignedUrlResponse {
    upload_url: string;
    s3_url: string;
}

export type CaptureType =
    | 'WEB_TEXT'
    | 'VIDEO_SEGMENT'
    | 'USER_NOTE'
    | 'RESOURCE_UPLOAD';

export type FileType = 'PDF' | 'IMAGE' | 'VIDEO_KEYFRAME' | 'RAW_TRANSCRIPT_JSON' | 'DOC';

export interface CaptureAttachmentInput {
    s3_url: string;
    file_type: FileType;
    file_name: string;
}

// ─────────────────────────────────────────────
// Chrome Message Types (Popup ↔ Background)
// ─────────────────────────────────────────────

export type MessageType =
    | 'GET_PROJECTS'
    | 'CREATE_PROJECT'
    | 'START_SESSION'
    | 'END_SESSION'
    | 'INGEST_BROWSER'
    | 'INGEST_VIDEO'
    | 'GET_PRESIGNED_URL'
    | 'GET_CAPTURES'
    | 'DELETE_CAPTURE'
    | 'PROCESS_DOCUMENT';

export interface BaseMessage {
    type: MessageType;
}

export interface GetProjectsMessage extends BaseMessage {
    type: 'GET_PROJECTS';
}

export interface CreateProjectMessage extends BaseMessage {
    type: 'CREATE_PROJECT';
    name: string;
    description?: string;
}

export interface StartSessionMessage extends BaseMessage {
    type: 'START_SESSION';
    project_id: string;
}

export interface EndSessionMessage extends BaseMessage {
    type: 'END_SESSION';
}

export interface IngestBrowserMessage extends BaseMessage {
    type: 'INGEST_BROWSER';
    payload: {
        session_id: string;
        project_id: string;
        capture_type: CaptureType;
        text_content?: string;
        source_url?: string;
        page_title?: string;
        video_start_time?: number;
        video_end_time?: number;
        priority: number;
        attachments?: CaptureAttachmentInput[];
    };
}

export interface IngestVideoMessage extends BaseMessage {
    type: 'INGEST_VIDEO';
    payload: {
        session_id: string;
        project_id: string;
        source_url: string;
        page_title: string;
        video_start_time: number;
        video_end_time: number;
        base64Frame: string;
    };
}

export interface GetPresignedUrlMessage extends BaseMessage {
    type: 'GET_PRESIGNED_URL';
    file_name: string;
    file_type: string;
}

export interface GetCapturesMessage extends BaseMessage {
    type: 'GET_CAPTURES';
    project_id: string;
}

export interface DeleteCaptureMessage extends BaseMessage {
    type: 'DELETE_CAPTURE';
    capture_id: string;
}

export interface ProcessDocumentMessage extends BaseMessage {
    type: 'PROCESS_DOCUMENT';
    capture_id: string;
    s3_url: string;
}

export type ExtensionMessage =
    | GetProjectsMessage
    | CreateProjectMessage
    | StartSessionMessage
    | EndSessionMessage
    | IngestBrowserMessage
    | IngestVideoMessage
    | GetPresignedUrlMessage
    | GetCapturesMessage
    | DeleteCaptureMessage
    | ProcessDocumentMessage;

// ─────────────────────────────────────────────
// Generic Response Wrapper
// ─────────────────────────────────────────────

export interface MessageResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
}
