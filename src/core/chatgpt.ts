export interface ChatgptAccount {
  enabled: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  email?: string;
  plan?: string;
  message?: string;
  login?: { url: string; code: string; expiresAt: string };
}
