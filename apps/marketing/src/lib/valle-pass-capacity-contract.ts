/** Protocol advertised by API previews that enforce campaign capacity server-side. */
export const VALE_PASS_CAPACITY_CONTRACT_VERSION = 'valle-pass-capacity-v1' as const;

export function supportsValePassCapacityContract(
  projection: { readonly capacityContractVersion?: string } | null | undefined,
): boolean {
  return projection?.capacityContractVersion === VALE_PASS_CAPACITY_CONTRACT_VERSION;
}
