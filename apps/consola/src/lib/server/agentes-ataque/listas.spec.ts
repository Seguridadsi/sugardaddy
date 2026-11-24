import { describe, expect, it, vi } from 'vitest';
import { consolaEn, FUENTE_LISTAS, FUENTE_MMD, FUENTE_TALOS, informeDe } from './listas';
import { _probar, panelesDe } from '../paneles-ataque';

describe('listas de ThreatDefence en el nodo', () => {
	it('vienen de un commit fijado y no están vacías', () => {
		expect(FUENTE_LISTAS.repo).toBe('ThreatDefence/agentic-attack-detections');
		expect(FUENTE_LISTAS.commit).toMatch(/^[0-9a-f]{40}$/);
	});

	it('reconoce la consola de un framework de ataque y nada más', () => {
		expect(consolaEn('1.13.183.49')).toMatchObject({ agente: 'ARTEX', version: null });
		expect(consolaEn('8.8.8.8')).toBeNull();
		/* No se deja engañar por las propiedades de los objetos. */
		expect(consolaEn('__proto__')).toBeNull();
		expect(consolaEn('constructor')).toBeNull();
	});

	it('una IP de un informe vale hasta su fecha de revisión', () => {
		const i = informeDe('101.53.80.20', new Date('2026-11-23T00:00:00Z'));
		expect(i).toMatchObject({ agentes: ['ARTEX'], fuente: 'CrowdStrike', confianza: 'medium' });
		expect(informeDe('101.53.80.20', new Date('2027-04-06T00:00:00Z'))).toBeNull();
		expect(informeDe('8.8.8.8')).toBeNull();
	});

	it('suma las IP de ARTEX de MalwareMustDie, con su autor y su fecha', () => {
		expect(FUENTE_MMD).toMatchObject({
			repo: 'unixfreaxjp/malwaremustdie',
			autor: 'MalwareMustDie.org - @unixfreaxjp'
		});
		/* Eye Security: VPS con instancias de ARTEX; solo está en el paquete de MMD. */
		const i = informeDe('207.5.195.93', new Date('2026-11-24T00:00:00Z'));
		expect(i).toMatchObject({ agentes: ['ARTEX'], fuente: 'Eye Security', confianza: 'medium' });
		expect(informeDe('207.5.195.93', new Date('2027-02-12T00:00:00Z'))).toBeNull();
		/* Un rango no entra como IP. */
		expect(informeDe('178.16.54.0/24')).toBeNull();
	});

	it('suma la infraestructura de ARTEX de Cisco Talos, hasta 180 días después', () => {
		expect(FUENTE_TALOS).toMatchObject({ repo: 'Cisco-Talos/IOCs' });
		expect(FUENTE_TALOS.commit).toMatch(/^[0-9a-f]{40}$/);
		/* Solo está en la lista de Talos. */
		const i = informeDe('1.117.76.217', new Date('2026-11-24T00:00:00Z'));
		expect(i).toMatchObject({
			agentes: ['ARTEX'],
			fuente: 'Cisco Talos',
			reportado: '2026-11-13',
			confianza: 'medium'
		});
		expect(informeDe('1.117.76.217', new Date('2027-05-13T00:00:00Z'))).toBeNull();
		/* Una IP que también da CrowdStrike sale con lo que dice ThreatDefence. */
		expect(informeDe('101.53.80.20', new Date('2026-11-24T00:00:00Z'))?.fuente).toBe('CrowdStrike');
		expect(informeDe('__proto__')).toBeNull();
	});

	it('la pista sale de la lista propia sin preguntar a la central', () => {
		const preguntar = vi.fn(async () => ({}));
		_probar(preguntar);
		expect(panelesDe(['1.13.183.49']).get('1.13.183.49')?.agente).toBe('ARTEX');
		expect(preguntar).not.toHaveBeenCalled();
		_probar(null);
	});
});
