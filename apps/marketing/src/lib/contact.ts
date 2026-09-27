/**
 * WhatsApp OFICIAL da VS by Closet: +55 87 9934-4613 (confirmado pelo
 * responsável do projeto em 2026-09-26). Formato internacional, só dígitos.
 * Se NEXT_PUBLIC_WHATSAPP estiver definida no ambiente, ela tem prioridade.
 */
export const OFFICIAL_WHATSAPP = process.env.NEXT_PUBLIC_WHATSAPP?.replace(/\D/g, '') || '558799344613';
