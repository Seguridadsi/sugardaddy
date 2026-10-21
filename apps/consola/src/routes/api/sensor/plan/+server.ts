import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, schema as s } from '$lib/server/db';
import { plan, sensorDe, versionAgente } from '$lib/server/sensor';

/*
 * El sensor lo pide cada pocos segundos: además del plan, cuenta como latido.
 * Con Sugardaddy-Registro: si dice que tiene credencial del registro privado;
 * sin ella (anteriores a la 0.12.1) recibe la imagen pública de una trampa si
 * el módulo la trae y, si no, esa trampa queda en espera con su motivo. Con
 * Sugardaddy-Version dice su versión: las trampas que piden un sensor más
 * nuevo (sensorMinimo) no se le mandan, y se guarda en version_agente (el
 * hecho agente.version de su destino). Las dos se escriben solo si cambian.
 */
export const GET = async ({ request }) => {
	const sensor = await sensorDe(request);
	const registro = request.headers.get('sugardaddy-registro') === 'si';
	const version = request.headers.get('sugardaddy-version');
	const agente = versionAgente(version);
	const cambios = {
		...(sensor.registroPrivado !== registro ? { registroPrivado: registro } : {}),
		...(sensor.versionAgente !== agente ? { versionAgente: agente } : {})
	};
	if (Object.keys(cambios).length)
		await db.update(s.sensores).set(cambios).where(eq(s.sensores.id, sensor.id));
	return json({
		sensor: sensor.id,
		ultimoHash: sensor.ultimoHash,
		...(await plan(sensor.id, registro, version ?? undefined))
	});
};
