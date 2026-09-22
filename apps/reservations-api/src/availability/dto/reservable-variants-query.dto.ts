import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';

/**
 * Query de GET /availability/reservable. Uma lista, não uma data — é a
 * pergunta "esta variante TEM alguma peça física ativa e reservável online
 * agora", não "em que dias". Usada pelo catálogo público pra não mostrar
 * uma variante sem nenhuma peça como se fosse reservável (a causa raiz do
 * bug: a listagem nunca consultava peça física nenhuma).
 */
export class ReservableVariantsQueryDto {
  /** `?shopifyVariantIds=a,b,c` — mesmo formato de lista simples usado em
   *  toda esta API pra parâmetros de query (nunca array[] do Nest, que
   *  exige repetir a chave). Dedup + trim aqui; vazio é erro de formato,
   *  não "nenhuma variante reservável". */
  @Transform(({ value }): string[] =>
    typeof value === 'string'
      ? [...new Set(value.split(',').map((v) => v.trim()).filter(Boolean))]
      : [],
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  shopifyVariantIds!: string[];
}
