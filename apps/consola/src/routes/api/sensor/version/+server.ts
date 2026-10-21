import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { compararVersiones } from '@sugardaddy/canal';
import { auditar } from '$lib/server/consultas';
import { db, schema as s } from '$lib/server/db';
import { releaseDelNodo, resultadoConfiguracionRemota, retenido } from '$lib/server/canal';
import { sensorDe } from '$lib/server/sensor';

/*
 * El actualizador de un sensor remoto pregunta aquí, con el token del sensor,
 * si hay una versión más nueva que la suya: la del nodo, firmada tal cual
 * llegó. Él vuelve a verificar la firma con su clave fijada.
 */
export const GET = async ({ request, url }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(403, 'El sensor local se actualiza con el nodo');
	if (await retenido(sensor.id)) return json(null);
	const actual = url.searchParams.get('actual') ?? '';
	if (!/^\d+\.\d+\.\d+$/.test(actual)) error(400, 'Falta la versión actual (?actual=x.y.z)');
	const { firmada, release } = await releaseDelNodo();
	return json(
		compararVersiones(release.version, actual) > 0
			? { version: release.version, release: firmada }
			: null
	);
};

export const POST = async ({ request }) => {
	const sensor = await sensorDe(request);
	if (!sensor.remoto) error(403, 'El sensor local se actualiza con el nodo');
	const b = await request.json().catch(() => null);
	if (typeof b?.version !== 'string' || !['aplicando', 'aplicada', 'fallida'].includes(b?.estado))
		error(400, 'Se esperaba { version, estado, detalle }');
	if (b.tipo === 'configuracion') {
		await resultadoConfiguracionRemota(sensor.id, b.version, b.estado, String(b.detalle ?? ''));
		return json({ ok: true });
	}
	if (b.estado === 'aplicada')
		await db.update(s.sensores).set({ version: b.version }).where(eq(s.sensores.id, sensor.id));
	if (b.estado !== 'aplicando')
		await auditar(`sensor ${sensor.id}`, `actualización ${b.estado}`, {
			version: b.version,
			detalle: String(b.detalle ?? '').slice(0, 500)
		});
	return json({ ok: true });
};
