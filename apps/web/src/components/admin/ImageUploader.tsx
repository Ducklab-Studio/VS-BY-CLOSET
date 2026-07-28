'use client';

import { useEffect, useRef, useState } from 'react';
import { Upload, Link2, Loader2 } from 'lucide-react';
import { adminApi } from '@/lib/admin-api';
import { Button, Input } from './ui';

interface PresignResponse {
  uploadUrl: string;
  publicUrl: string;
  key: string;
}

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Envia a imagem direto do navegador para o object storage usando uma URL
 * pré-assinada. O binário não passa pela API — o container não vira gargalo de
 * banda e não precisa de disco, que é o requisito para escalar horizontalmente.
 */
export function ImageUploader({ onUploaded }: { onUploaded: (url: string) => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [storageEnabled, setStorageEnabled] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);

  useEffect(() => {
    adminApi
      .get<{ enabled: boolean }>('/admin/uploads/status')
      .then((r) => setStorageEnabled(r.enabled))
      .catch(() => setStorageEnabled(false));
  }, []);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setError('');

    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        setError(`"${file.name}" passa de 8 MB.`);
        continue;
      }
      try {
        const presigned = await adminApi.post<PresignResponse>('/admin/uploads/presign', {
          contentType: file.type,
          sizeBytes: file.size,
          folder: 'produtos',
        });
        await putWithProgress(presigned.uploadUrl, file, setProgress);
        await onUploaded(presigned.publicUrl);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setProgress(null);
      }
    }

    if (inputRef.current) inputRef.current.value = '';
  }

  async function addManualUrl() {
    if (!manualUrl.trim()) return;
    setSavingUrl(true);
    setError('');
    try {
      await onUploaded(manualUrl.trim());
      setManualUrl('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingUrl(false);
    }
  }

  return (
    <div className="space-y-3">
      {storageEnabled && (
        <div>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={progress !== null}
            className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-white/20 px-6 py-8 text-sm text-white/60 transition hover:border-white/40 hover:text-white disabled:opacity-60"
          >
            {progress !== null ? (
              <>
                <Loader2 size={20} className="animate-spin" />
                <span>Enviando… {progress}%</span>
                <span className="h-1 w-48 overflow-hidden rounded-full bg-white/10">
                  <span
                    className="block h-full rounded-full bg-white transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </span>
              </>
            ) : (
              <>
                <Upload size={20} />
                <span>Clique para enviar imagens</span>
                <span className="text-xs text-white/35">JPG, PNG, WebP ou AVIF · até 8 MB</span>
              </>
            )}
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Link2
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35"
          />
          <Input
            placeholder={
              storageEnabled === false
                ? 'Cole a URL da imagem (storage não configurado)'
                : 'Ou cole uma URL de imagem'
            }
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button onClick={addManualUrl} loading={savingUrl}>
          Adicionar
        </Button>
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}
    </div>
  );
}

/**
 * PUT com barra de progresso. Usa XHR porque `fetch` não expõe progresso de
 * upload — `ReadableStream` como body ainda não é suportado de forma confiável
 * pelos navegadores.
 */
function putWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Falha no envio ao storage (HTTP ${xhr.status}).`));
    xhr.onerror = () => reject(new Error('Erro de rede ao enviar a imagem.'));

    onProgress(0);
    xhr.send(file);
  });
}
