type NegativeResult = { mappingKey: string; receiptId: string };

/** Adapter-local FIFO. Positive receipts/recovery records are never evicted. */
export async function retainNegativeResult(tx: DurableObjectTransaction, entry: NegativeResult, ceiling: number) {
  const key = 'api:negative-results';
  const entries = [...(await tx.get<NegativeResult[]>(key) ?? []), entry];
  const evicted = entries.splice(0, Math.max(0, entries.length - ceiling));
  for (const previous of evicted) await tx.delete([previous.mappingKey, `receipt:${previous.receiptId}`]);
  await tx.put(key, entries);
}
