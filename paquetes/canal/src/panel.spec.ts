import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	clavesPanelTras,
	firmanteDePrivada,
	firmarComoPanel,
	firmarEstado,
	firmarLista,
	firmarRelease,
	generarClaves,
	huella,
	verificarEstado,
	verificarLista,
	verificarRelease,
	type EstadoDeseado,
	type FirmantePanel,
	type ListaGlobal,
	type Release
} from './index.ts';

/* Una clave como la del HSM: ECDSA P-256, firma ES256 en r||s. */
function claveHsm(): FirmantePanel & {
	privada: ReturnType<typeof generateKeyPairSync>['privateKey'];
} {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	return {
		privada: privateKey,
		publica: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
		firmar: async (texto) =>
			sign('sha256', Buffer.from(texto), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString(
				'base64'
			)
	};
}

const legado = generarClaves();
const fichero: FirmantePanel = firmanteDePrivada(legado.privada, legado.publica);

const estado = (): EstadoDeseado => ({
	version: 1,
	cliente: 'acme',
	versionObjetivo: '0.30.0',
	release: null,
	anillo: 'general',
	despliegueEnPausa: false,
	soporte: null,
	modulos: [],
	emitido: new Date().toISOString(),
	caduca: new Date(Date.now() + 3600_000).toISOString()
});

describe('firmar como el panel', () => {
	it('en la transición: Ed25519 en firma y la del HSM en firmas; valen las dos', async () => {
		const hsm = claveHsm();
		const texto = JSON.stringify(estado());
		const f = await firmarComoPanel(texto, fichero, [hsm]);
		expect(f.firmas).toEqual([{ clave: huella(hsm.publica), firma: expect.any(String) }]);
		/* Un nodo de antes (solo la Ed25519 fijada) y uno rotado (solo la del HSM). */
		expect(verificarEstado(legado.publica, 'acme', { estado: texto, ...f }).ok).toBe(true);
		expect(verificarEstado([hsm.publica], 'acme', { estado: texto, ...f }).ok).toBe(true);
		/* Una clave que no está en la lista no vale aunque firme bien. */
		const otra = claveHsm();
		const g = await firmarComoPanel(texto, otra);
		expect(verificarEstado([hsm.publica], 'acme', { estado: texto, ...g }).ok).toBe(false);
	});

	it('solo con el HSM: la firma ECDSA va en firma', async () => {
		const hsm = claveHsm();
		const texto = JSON.stringify(estado());
		const f = await firmarComoPanel(texto, hsm);
		expect(f.firmas).toBeUndefined();
		expect(verificarEstado([legado.publica, hsm.publica], 'acme', { estado: texto, ...f }).ok).toBe(
			true
		);
		expect(verificarEstado(legado.publica, 'acme', { estado: texto, ...f }).ok).toBe(false);
	});

	it('no deja salir una firma que no se comprueba con la pública', async () => {
		const hsm = claveHsm();
		const mentiroso: FirmantePanel = { publica: hsm.publica, firmar: async () => 'A'.repeat(88) };
		await expect(firmarComoPanel('x', mentiroso)).rejects.toThrow(/does not verify/);
	});

	it('la firma de siempre sigue valiendo con la clave suelta', () => {
		const f = firmarEstado(legado.privada, estado());
		expect(verificarEstado(legado.publica, 'acme', f).ok).toBe(true);
	});

	it('las listas comunes aceptan las firmas nuevas', async () => {
		const hsm = claveHsm();
		const l: ListaGlobal = {
			version: 1,
			emitida: new Date().toISOString(),
			caduca: new Date(Date.now() + 3600_000).toISOString(),
			indicadores: []
		};
		const vieja = firmarLista(legado.privada, l);
		expect(verificarLista(legado.publica, vieja).ok).toBe(true);
		const nueva = { lista: vieja.lista, ...(await firmarComoPanel(vieja.lista, fichero, [hsm])) };
		expect(verificarLista([hsm.publica], nueva).ok).toBe(true);
		expect(verificarLista([claveHsm().publica], nueva).ok).toBe(false);
	});
});

describe('rotar las claves del panel con una versión firmada', () => {
	const hsm = claveHsm();
	const msp = generarClaves();

	it('el nodo de este panel adopta la lista; el de otro panel no la toca', () => {
		const c = { claves: [legado.publica, hsm.publica] };
		expect(clavesPanelTras([legado.publica], c)).toEqual([legado.publica, hsm.publica]);
		expect(clavesPanelTras([msp.publica], c)).toBeNull();
		/* Sin cambios: null. */
		expect(clavesPanelTras([hsm.publica, legado.publica], c)).toBeNull();
	});

	it('reemplaza: un nodo que se saltó la transición pasa a la clave nueva', () => {
		const c = { claves: [hsm.publica], reemplaza: [huella(legado.publica)] };
		expect(clavesPanelTras([legado.publica], c)).toEqual([hsm.publica]);
		expect(clavesPanelTras([msp.publica], c)).toBeNull();
	});

	it('la versión firmada la lleva, y una mal formada no se acepta', () => {
		const pub = generarClaves();
		const D = '@sha256:' + 'a'.repeat(64);
		const r = (clavesPanel: unknown): Release =>
			({
				version: '0.30.0',
				publicada: '2026-11-14T10:00:00Z',
				notas: 'x',
				servicios: { consola: `ejemplo.azurecr.io/sugardaddy-consola${D}` },
				clavesPanel
			}) as Release;
		const buena = verificarRelease(
			pub.publica,
			firmarRelease(pub.privada, r({ claves: [hsm.publica] }))
		);
		expect(buena.ok && buena.release.clavesPanel).toEqual({ claves: [hsm.publica] });
		for (const mala of [
			{ claves: [] },
			{ claves: ['AAAA'] },
			{ claves: [hsm.publica], reemplaza: ['no-es-huella'] },
			'texto'
		]) {
			const v = verificarRelease(pub.publica, firmarRelease(pub.privada, r(mala)));
			expect(v.ok).toBe(false);
		}
	});
});
