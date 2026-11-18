/*
 * Las técnicas de MITRE ATT&CK de cada IP son de Cloud («Qué hacer ahora»). En esta
 * edición el nodo no las sube; el panel deduce lo que puede de los módulos.
 */
import type { SQL } from 'drizzle-orm';

export async function tecnicasPorIp(
	_subibles: SQL | undefined,
	_ips: string[]
): Promise<Map<string, string[]>> {
	return new Map();
}
