export interface ChatgptAccount {
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  method?: 'chatgpt' | 'api';
  baseUrl?: string;
  email?: string;
  plan?: string;
  message?: string;
  login?: { url: string; code: string; expiresAt: string };
}
