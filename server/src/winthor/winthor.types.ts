export interface WinthorLoginResponse {
  accessToken: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  statusCode?: number;
}
