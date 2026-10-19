export const remoteStudio = typeof location !== 'undefined' && !['127.0.0.1', 'localhost'].includes(location.hostname);
export function downloadFile(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}
