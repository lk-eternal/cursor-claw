export const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
export const MessageItemKind = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

export interface TextItem { text?: string; }
export interface ImageItem { media?: CDNMedia; aeskey?: string; mid_size?: number; }
export interface VoiceItem { media?: CDNMedia; text?: string; }
export interface FileItem { media?: CDNMedia; file_name?: string; len?: string; }
export interface VideoItem { media?: CDNMedia; video_size?: number; }

export interface MessageItem {
  type: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

export interface WeixinMessage {
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  group_id?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  upload_full_url?: string;
  filekey?: string;
}

export interface GetConfigResp {
  typing_ticket?: string;
}

export interface QRCodeResp {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRCodeStatusResp {
  status: "wait" | "scaned" | "expired" | "confirmed";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}

export interface LoginResult {
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
}

export interface UploadResult {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

export interface DownloadResult {
  data: Buffer;
  kind: string;
  fileName?: string;
}
