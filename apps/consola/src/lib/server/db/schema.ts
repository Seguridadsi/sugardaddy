/*
 * Esquema de la consola del nodo.
 *
 * Dos reglas:
 *
 * 1. EL EVENTO ES LA LÍNEA. Cada evento se guarda con los bytes exactos que
 *    emitió el sensor (`linea`) y su hash. Las demás columnas son copias para
 *    poder filtrar; si alguna vez no coinciden, manda la línea.
 *
 * 2. NADA SE BORRA SIN DEJAR RASTRO. Las decisiones (aprobar, añadir a una
 *    lista, cambiar una regla) quedan en `auditoria`, que solo crece.
 */

import { sql } from 'drizzle-orm';
import {
	bigint,
	bigserial,
	boolean,
	check,
	integer,
	index,
	jsonb,
	pgTable,
	primaryKey,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import type {
	Accion,
	Capacidades,
	Colocacion,
	DescripcionDestino,
	Marca,
	PasosGenerados,
	Severidad
} from '@sugardaddy/contrato';

const creado = () => timestamp('creado', { withTimezone: true }).notNull().defaultNow();

export const sensores = pgTable('sensores', {
	id: text('id').primaryKey(),
	nombre: text('nombre').notNull(),
	/*
	 * Lo que escribía una consola anterior a «red» y «vlan»: ya no se lee ni se
	 * escribe. Se queda, sin NOT NULL, para que esa consola siga funcionando si
	 * el nodo vuelve atrás a ella tras actualizarse.
	 */
	segmento: text('segmento'),
	/*
	 * La red de su máquina (CIDR IPv4, p. ej. 10.70.0.0/24) y su VLAN, si se
	 * saben. Las detecta el instalador (el del nodo para el sensor local, el
	 * de su línea para uno remoto); las dos se cambian en Sensores.
	 */
	red: text('red'),
	vlan: integer('vlan'),
	/* sha256 del token del sensor. El token solo se ve una vez, al darlo de alta. */
	claveHash: text('clave_hash').notNull(),
	/* Hash de la última línea aceptada: la siguiente tiene que traerlo en hashAnterior. */
	ultimoHash: text('ultimo_hash').notNull().default('0'.repeat(64)),
	ultimoLatido: timestamp('ultimo_latido', { withTimezone: true }),
	/* En otra máquina (otra VLAN, sede o nube), instalado con su propia línea. */
	remoto: boolean('remoto').notNull().default(false),
	/* Versión que dice tener su actualizador; solo los remotos, el local va con el nodo. */
	version: text('version'),
	/* Cómo quedó la configuración firmada en un sensor remoto (desde la 0.12). */
	configuracion: jsonb('configuracion').$type<{
		version: string;
		estado: 'aplicando' | 'aplicada' | 'fallida';
		detalle: string | null;
		cuando: string;
	}>(),
	/*
	 * Si al pedir el plan dice que tiene credencial del registro privado. Sin
	 * ella recibe la imagen pública de una trampa si el módulo la trae
	 * (contenedor.imagenPublica); si no, esa trampa no se le manda y queda en
	 * espera, con su motivo en trampas.donde, hasta que se ponga al día.
	 */
	registroPrivado: boolean('registro_privado'),
	/*
	 * Lo que el sensor cuenta de su máquina en cada informe de estado (desde
	 * la 0.13.1): su motor de contenedores, o por qué no puede usarlo, y los
	 * hechos que sabe, como red.ipOrigenReal. Ver leerCapacidades en el contrato.
	 */
	capacidades: jsonb('capacidades').$type<Capacidades & { cuando: string }>(),
	/*
	 * La versión del agente según la cabecera Sugardaddy-Version de su último
	 * plan (la escribe la ruta del plan solo si cambia). No es «version», que
	 * es la que dice el actualizador de un sensor remoto.
	 */
	versionAgente: text('version_agente'),
	creado: creado()
});

/*
 * Los sitios donde se pone algo (docs/diseno/modulo-despliegue.md §5): una
 * máquina con sensor, que se crea con él, o un servidor, una web o un tenant
 * que el cliente describe con el formulario corto. El id no depende del
 * sensor: el destino de un sensor se busca siempre por «sensor».
 *
 * Lo que cuenta el sensor de su máquina no se copia aquí: se lee de
 * sensores.capacidades y se junta al leer con lo que dijo el cliente
 * («descripcion»), que un sensor nunca pisa.
 */
export const destinos = pgTable(
	'destinos',
	{
		id: text('id').primaryKey(),
		nombre: text('nombre').notNull(),
		/* maquina, fileserver, web… Contrato abierto: se valida en TypeScript, no con un CHECK. */
		tipo: text('tipo').notNull(),
		/*
		 * Si una consola anterior (tras volver atrás) borra el sensor, el destino
		 * se queda sin él en lugar de dar un error.
		 */
		sensor: text('sensor').references(() => sensores.id, { onDelete: 'set null' }),
		/* Las respuestas del formulario corto (DescripcionDestino). */
		descripcion: jsonb('descripcion').$type<DescripcionDestino>().notNull().default({}),
		activo: boolean('activo').notNull().default(true),
		creado: creado()
	},
	(t) => [
		uniqueIndex('destinos_sensor')
			.on(t.sensor)
			.where(sql`${t.sensor} IS NOT NULL`)
	]
);

/*
 * Líneas de instalación de sensores remotos. Solo se guarda el hash del
 * código: vale una vez y caduca a las 24 horas.
 */
export const instaladoresSensor = pgTable('instaladores_sensor', {
	codigoHash: text('codigo_hash').primaryKey(),
	sensor: text('sensor')
		.notNull()
		.references(() => sensores.id),
	caduca: timestamp('caduca', { withTimezone: true }).notNull(),
	usado: timestamp('usado', { withTimezone: true }),
	creado: creado()
});

export const COLOCACIONES = [
	'por-colocar',
	'colocada',
	'comprobada',
	'degradada',
	'retirando'
] as const satisfies readonly Colocacion[];

/*
 * Todo lo que se añadió con el módulo de despliegue (0012) admite nulos o
 * tiene valor por defecto: la consola anterior, a la que vuelve el
 * actualizador sin restaurar la base de datos, sigue insertando trampas sin
 * esas columnas y borrando sin comprobar nada más.
 */
export const trampas = pgTable(
	'trampas',
	{
		id: text('id').primaryKey(),
		nombre: text('nombre').notNull(),
		modulo: text('modulo').notNull(),
		tipo: text('tipo', { enum: ['contenedor', 'fichero', 'token', 'identidad'] }).notNull(),
		/*
		 * El sensor que la despliega o, en una trampa manual, el que recibe su
		 * señal (el de la trampa objetivo).
		 */
		sensor: text('sensor')
			.notNull()
			.references(() => sensores.id),
		donde: text('donde').notNull(),
		/* Ya validados contra el esquema del módulo al darlo de alta. */
		parametros: jsonb('parametros').$type<Record<string, unknown>>().notNull().default({}),
		activo: boolean('activo').notNull().default(true),
		/*
		 * Dónde está puesta. Nula = la máquina de su sensor, que es lo que deja
		 * el INSERT de una consola anterior (scripts/destinos.mjs lo completa al
		 * arrancar); pasa a NOT NULL dos versiones después de la 0012.
		 */
		destino: text('destino').references(() => destinos.id),
		/* La vía del manifiesto con que se puso (o uno de sus «antes»). */
		via: text('via').notNull().default('contenedor'),
		ejecutor: text('ejecutor').notNull().default('contenedor@1'),
		colocacion: text('colocacion', { enum: COLOCACIONES }).notNull().default('por-colocar'),
		/* Código del último motivo (fase.causa): por qué está por colocar o degradada. */
		colocacionMotivo: text('colocacion_motivo'),
		colocacionCuando: timestamp('colocacion_cuando', { withTimezone: true }),
		/* El primer evento real recibido por su señal: «activa» solo desde entonces. */
		comprobada: timestamp('comprobada', { withTimezone: true }),
		/* manual@1: los pasos de colocar y de retirar tal como se generaron. */
		manual: jsonb('manual').$type<PasosGenerados>(),
		/*
		 * La trampa que recibe su señal (fuente «trampa»). Si una consola
		 * anterior borra esa trampa, aquí queda nulo y esta se ve «sin señal»;
		 * la consola de hoy no deja retirarla mientras tenga dependientes.
		 */
		senalTrampa: text('senal_trampa').references((): AnyPgColumn => trampas.id, {
			onDelete: 'set null'
		}),
		creado: creado()
	},
	(t) => [
		check(
			'trampas_colocacion',
			sql`${t.colocacion} IN ('por-colocar','colocada','comprobada','degradada','retirando')`
		),
		index('trampas_destino').on(t.destino),
		index('trampas_senal_trampa')
			.on(t.senalTrampa)
			.where(sql`${t.senalTrampa} IS NOT NULL`)
	]
);

export const eventos = pgTable(
	'eventos',
	{
		id: uuid('id').primaryKey(),
		sensor: text('sensor')
			.notNull()
			.references(() => sensores.id),
		linea: text('linea').notNull(),
		hash: text('hash').notNull(),
		/* Copias de la línea, para filtrar. Origen y detalle los escribió el atacante. */
		cuando: timestamp('cuando', { withTimezone: true }).notNull(),
		trampa: text('trampa').notNull(),
		modulo: text('modulo').notNull(),
		tipo: text('tipo').notNull(),
		accion: text('accion').notNull(),
		severidad: text('severidad', { enum: ['baja', 'media', 'alta', 'critica'] }).notNull(),
		ip: text('ip'),
		usuario: text('usuario'),
		conexionEstablecida: boolean('conexion_establecida').notNull(),
		/* La contraseña que probó el atacante, si la trampa tiene login (la dice su manifiesto). */
		contrasena: text('contrasena'),
		/*
		 * Por qué este evento es una alerta (p. ej., la contraseña lleva el nombre
		 * de la empresa). Con alerta, severidad sube a crítica; la línea firmada
		 * no se toca, conserva la severidad que puso el sensor.
		 */
		alerta: text('alerta'),
		recibido: timestamp('recibido', { withTimezone: true }).notNull().defaultNow(),
		/*
		 * Lo ha provocado quien pulsó «Probar» (§8.3): comprueba la trampa y se
		 * ve como los demás, con su etiqueta, pero no es un ataque. No pasa al
		 * motor de respuesta, no da alerta y no se comparte como indicador. La
		 * línea firmada no se toca. La consola anterior no la escribe: false.
		 */
		prueba: boolean('prueba').notNull().default(false)
	},
	(t) => [
		uniqueIndex('eventos_hash').on(t.hash),
		index('eventos_cuando').on(t.cuando),
		index('eventos_trampa').on(t.trampa),
		index('eventos_contrasena').on(t.contrasena),
		index('eventos_ip').on(t.ip),
		/* El borrado por plazo de conservación (conservacion.ts) va por «recibido». */
		index('eventos_recibido').on(t.recibido)
	]
);

/*
 * «Probar» una trampa (docs/diseno/modulo-despliegue.md §8.3, §9.2): una
 * ventana de unos minutos en la que cuenta como prueba un evento de la
 * trampa, o de la trampa que recibe su señal si la activa, recibido (reloj
 * de la consola) entre «desde» y «hasta» más 2 minutos, que cumpla «marca»
 * o, si la prueba no tiene, venga de «ip». «evento» es el primero que llegó.
 *
 * «marca» se guarda ya rellena con los valores reales y el nonce: así la
 * entrega de eventos no vuelve a leer el catálogo y un cambio del módulo a
 * mitad de prueba no cambia lo que se espera. Se borran con su trampa.
 */
export const pruebas = pgTable(
	'pruebas',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		trampa: text('trampa')
			.notNull()
			.references(() => trampas.id, { onDelete: 'cascade' }),
		/* 8 caracteres [a-z0-9]: lo que hace única esta prueba en sus pasos y en su marca. */
		nonce: text('nonce').notNull(),
		ip: text('ip'),
		marca: jsonb('marca').$type<Marca>(),
		desde: timestamp('desde', { withTimezone: true }).notNull().defaultNow(),
		hasta: timestamp('hasta', { withTimezone: true }).notNull(),
		evento: uuid('evento'),
		quien: text('quien').notNull()
	},
	(t) => [index('pruebas_abiertas').on(t.trampa, t.hasta)]
);

/*
 * Las balizas (H22 Word, H23 Excel, H24 PDF, y las de nube de la tanda de
 * conectores, H28–H31): un token por honeycosa que la ata al receptor de
 * balizas que la enciende (docs/diseno/receptor-baliza.md). Al dar de alta
 * la honeycosa sobre un nodo con receptor se acuña el documento con la URL
 * del sensor del cliente (http(s)://<dirección>:<puerto>/b/<token>) y se
 * guarda aquí el token, su URL y el fichero acuñado para descargarlo; las
 * de nube (clase «webhook», «acs» o «enlace») solo acuñan el token y su
 * URL: el cebo es una clave, una app o una línea de CSS, no un documento.
 * Cuando llega un evento accion:baliza con ese token, la consola lo
 * atribuye a esta honeycosa y la da por comprobada; un token que no está
 * aquí se descarta sin tocar nada.
 *
 * Tabla nueva y sin que nadie más la referencie: la consola anterior, a la
 * que vuelve el actualizador sin restaurar la base de datos, ni la ve, y
 * sigue dando de alta y retirando honeycosas de fichero como siempre (sin
 * baliza, que es lo que hacía). La columna «clase» y el nullable de los
 * campos de fichero la respetan igual: las INSERT de esa consola no la
 * mencionan y caen en el DEFAULT «documento», y siempre traen los cuatro
 * campos de fichero (módulo-despliegue.md, regla de compatibilidad).
 * Se borra con su honeycosa (cascade).
 */
export const balizas = pgTable(
	'balizas',
	{
		/* El identificador aleatorio de la baliza (>= 22 caracteres base64url). */
		token: text('token').primaryKey(),
		/*
		 * La clase de baliza (§2.5 de la ronda conectores-tanda1): «documento»
		 * lleva el cebo acuñado (H22–H24); «webhook» (H28, H29), «acs» (H31) y
		 * «enlace» (H30, el píxel) son las de nube, que solo siembran la URL.
		 */
		clase: text('clase').notNull().default('documento'),
		/* La honeycosa dueña del token. Una honeycosa, un token. */
		trampa: text('trampa')
			.notNull()
			.references(() => trampas.id, { onDelete: 'cascade' }),
		/* El destino donde se deja el cebo (hoy, el documento). */
		destino: text('destino').references(() => destinos.id, { onDelete: 'set null' }),
		/* El sensor con el receptor que recibe sus balizas (puede no ser el del destino). */
		sensor: text('sensor')
			.notNull()
			.references(() => sensores.id),
		/* La trampa receptor-balizas que la enciende, para rehacer su URL. */
		receptor: text('receptor').references((): AnyPgColumn => trampas.id, {
			onDelete: 'set null'
		}),
		/* La URL de baliza sembrada en el cebo. */
		url: text('url').notNull(),
		/*
		 * El documento acuñado (base64) para descargarlo, con su nombre y su
		 * tipo: solo las de clase «documento».
		 */
		fichero: text('fichero'),
		nombre: text('nombre'),
		tipo: text('tipo'),
		sha256: text('sha256'),
		/* El nonce de la prueba «Probar» en curso (un solo uso), su ventana y cuándo se gastó. */
		nonce: text('nonce'),
		nonceHasta: timestamp('nonce_hasta', { withTimezone: true }),
		nonceUsado: timestamp('nonce_usado', { withTimezone: true }),
		creado: creado()
	},
	(t) => [uniqueIndex('balizas_trampa').on(t.trampa), index('balizas_sensor').on(t.sensor)]
);

/*
 * Cada evento que activa una trampa cuya señal es otra (§8.5, paso 13): un
 * evento puede activar más de una (dos marcas solapadas que dejó una vuelta
 * atrás) y cada una tiene que poder decir dónde se usó lo sembrado. Sin
 * clave hacia trampas: un evento es historia y sobrevive a la trampa que
 * activó. Un evento solo se borra al pasar su plazo de conservación, y se
 * lleva sus activaciones (conservacion.ts).
 */
export const activaciones = pgTable(
	'activaciones',
	{
		evento: uuid('evento')
			.notNull()
			.references(() => eventos.id),
		trampa: text('trampa').notNull(),
		recibido: timestamp('recibido', { withTimezone: true }).notNull()
	},
	(t) => [
		primaryKey({ columns: [t.evento, t.trampa] }),
		index('activaciones_trampa').on(t.trampa, t.recibido)
	]
);

export type ModoRespuesta = 'automatica' | 'aprobacion' | 'simulacion';

/*
 * Lo que un sensor entregó y no pudo guardarse como evento: una línea
 * ilegible, que no cumple el contrato, de una trampa retirada o de otro
 * sensor, o que repite un evento ya recibido. Se guarda con su hash y el
 * motivo, y la entrega sigue: una línea mala nunca deja al sensor parado, y
 * la cadena se puede seguir verificando juntando eventos y cuarentena.
 */
export const cuarentena = pgTable(
	'cuarentena',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		sensor: text('sensor')
			.notNull()
			.references(() => sensores.id),
		hash: text('hash').notNull(),
		/* El de la línea, si se pudo leer: para recomponer la cadena. */
		hashAnterior: text('hash_anterior'),
		linea: text('linea').notNull(),
		motivo: text('motivo').notNull(),
		recibido: timestamp('recibido', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('cuarentena_hash').on(t.hash),
		index('cuarentena_sensor').on(t.sensor),
		index('cuarentena_recibido').on(t.recibido)
	]
);

/*
 * Una línea que no continúa la cadena del sensor (estado perdido, base de
 * datos restaurada, o alguien borrando eventos). Se anota aquí y se sigue
 * recibiendo desde ella: queda la prueba de la ruptura, y la consola no se
 * queda ciega.
 */
export const rupturas = pgTable('rupturas', {
	id: bigserial('id', { mode: 'number' }).primaryKey(),
	sensor: text('sensor')
		.notNull()
		.references(() => sensores.id),
	esperado: text('esperado').notNull(),
	recibido: text('recibido').notNull(),
	hash: text('hash').notNull(),
	cuando: timestamp('cuando', { withTimezone: true }).notNull().defaultNow()
});

export const reglas = pgTable('reglas', {
	id: text('id').primaryKey(),
	nombre: text('nombre').notNull(),
	severidadMinima: text('severidad_minima', {
		enum: ['baja', 'media', 'alta', 'critica']
	}).notNull(),
	/* null: todas las trampas. */
	trampas: jsonb('trampas').$type<string[] | null>(),
	respuestas: jsonb('respuestas').$type<{ modulo: string; modo: ModoRespuesta }[]>().notNull(),
	activa: boolean('activa').notNull().default(true),
	creado: creado()
});

export const aprobaciones = pgTable('aprobaciones', {
	id: uuid('id').primaryKey().defaultRandom(),
	regla: text('regla')
		.notNull()
		.references(() => reglas.id),
	respuesta: text('respuesta').notNull(),
	objetivo: text('objetivo').notNull(),
	evento: uuid('evento')
		.notNull()
		.references(() => eventos.id),
	estado: text('estado', { enum: ['pendiente', 'aprobada', 'rechazada'] })
		.notNull()
		.default('pendiente'),
	decididoPor: text('decidido_por'),
	decididoEn: timestamp('decidido_en', { withTimezone: true }),
	creado: creado()
});

/*
 * Cada intento de respuesta, salga como salga: ejecutada, fallida, bloqueada
 * por una guarda, simulada o a la espera de aprobación. Es lo que permite
 * responder "¿por qué se bloqueó esta IP?" o "¿por qué no se bloqueó?".
 */
export const ejecuciones = pgTable(
	'ejecuciones',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		evento: uuid('evento')
			.notNull()
			.references(() => eventos.id),
		regla: text('regla')
			.notNull()
			.references(() => reglas.id),
		respuesta: text('respuesta').notNull(),
		modo: text('modo', { enum: ['automatica', 'aprobacion', 'simulacion'] }).notNull(),
		objetivo: text('objetivo').notNull(),
		estado: text('estado', {
			enum: ['ejecutada', 'fallida', 'bloqueada', 'simulada', 'pendiente-aprobacion']
		}).notNull(),
		/* Qué guarda la paró, qué devolvió el ejecutor. Nunca secretos. */
		motivo: text('motivo'),
		aprobacion: uuid('aprobacion').references(() => aprobaciones.id),
		cuando: timestamp('cuando', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('ejecuciones_objetivo').on(t.objetivo, t.regla, t.cuando)]
);

/*
 * Configuración de cada respuesta en este nodo: sus parámetros (validados
 * contra el manifiesto) y sus secretos, cifrados con la clave del nodo. Los
 * secretos no salen nunca de aquí.
 */
export const respuestasConfig = pgTable('respuestas_config', {
	modulo: text('modulo').primaryKey(),
	parametros: jsonb('parametros').$type<Record<string, unknown>>().notNull().default({}),
	secretosCifrados: text('secretos_cifrados'),
	actualizado: timestamp('actualizado', { withTimezone: true }).notNull().defaultNow()
});

export const listas = pgTable(
	'listas',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		valor: text('valor').notNull(),
		clase: text('clase', { enum: ['ip', 'red', 'dominio', 'hash', 'usuario'] }).notNull(),
		lista: text('lista', { enum: ['negra', 'blanca'] }).notNull(),
		ambito: text('ambito', { enum: ['local', 'global'] }).notNull(),
		motivo: text('motivo').notNull(),
		caduca: timestamp('caduca', { withTimezone: true }),
		quien: text('quien').notNull(),
		creado: creado()
	},
	(t) => [uniqueIndex('listas_unica').on(t.valor, t.lista, t.ambito)]
);

/* ---------------------------------------------------------------------------
 * Salidas: avisos y SIEM (docs/diseno/avisos-y-siem.md)
 *
 * Lo que sale del nodo hacia las herramientas del propio cliente (su SIEM, su
 * correo, Teams, Slack…), nunca hacia SeguridadSI. Cada salida tiene su cola
 * en salidas_cola, con tope: si su destino no responde, lo suyo espera ahí y
 * la recepción de eventos sigue igual.
 *
 * Tablas nuevas y sin claves hacia las de antes: la consola anterior, a la
 * que vuelve el actualizador sin restaurar la base de datos, ni las ve, y
 * sigue borrando trampas y sensores como siempre.
 * ------------------------------------------------------------------------- */

/* Qué manda una salida. Los avisos de salud van todos o ninguno: son pocos y del nodo entero. */
export type ReglasSalida = {
	/* Los eventos de las trampas, con estos filtros. */
	eventos: boolean;
	severidadMinima: Severidad;
	/* null: todas las trampas, también las que se pongan después. */
	trampas: string[] | null;
	/* null: todas las acciones. */
	acciones: Accion[] | null;
	/* Sensor sin latido, trampa caída o parada, cola de otra salida llena. */
	salud: boolean;
};

/* Cada mensaje en cuanto se puede, o todos juntos cada N minutos. */
export type Agrupacion = { modo: 'inmediato' } | { modo: 'resumen'; minutos: number };

/*
 * Lo que una salida ha tenido que tirar en un episodio: porque su cola
 * estaba llena o porque su destino lo rechazó para siempre. Se le cuenta en
 * un aviso cuando vuelve a ir bien, y queda en la auditoría.
 */
export type Descartes = {
	total: number;
	llena: number;
	rechazados: number;
	porSeveridad: Partial<Record<Severidad, number>>;
	desde: string;
	hasta: string;
};

/* De cada secreto puesto: cuándo, quién y, si es largo, sus 4 últimos caracteres. Nunca el valor. */
export type InfoSecreto = { cuando: string; quien: string; final: string | null };

/* Un aviso tal como espera en la cola: el nodo se le añade al enviarlo. */
export type AvisoGuardado = {
	id: string;
	cuando: string;
	severidad: Severidad;
	/* salud.sensor-sin-latido, salud.trampa-caida, salida.cola-llena, salida.prueba… */
	codigo: string;
	titulo: string;
	texto: string;
	sobre?: { tipo: 'sensor' | 'trampa' | 'salida'; id: string; nombre: string };
	/* El problema del que avisó antes se ha resuelto. */
	resuelto?: boolean;
	/* Datos que acompañan al aviso (p. ej. el resumen de lo descartado). */
	datos?: Record<string, unknown>;
};

export const salidas = pgTable('salidas', {
	id: uuid('id').primaryKey().defaultRandom(),
	/* prueba, syslog, webhook, correo… Contrato abierto: se valida en TypeScript, no con un CHECK. */
	tipo: text('tipo').notNull(),
	nombre: text('nombre').notNull(),
	activa: boolean('activa').notNull().default(true),
	/* Lo que no es secreto, validado contra los parámetros de su canal. */
	configuracion: jsonb('configuracion').$type<Record<string, unknown>>().notNull().default({}),
	/*
	 * Sus secretos (un objeto id → valor), cifrados con AES-256-GCM con la
	 * clave del nodo (CLAVE_SECRETOS, que no sale de su .env) y ligados a esta
	 * salida (secretos.ts). Sin la clave con que se cifraron, la salida pide
	 * que se vuelvan a poner.
	 */
	secretosCifrados: text('secretos_cifrados'),
	secretosInfo: jsonb('secretos_info').$type<Record<string, InfoSecreto>>().notNull().default({}),
	reglas: jsonb('reglas').$type<ReglasSalida>().notNull(),
	agrupacion: jsonb('agrupacion').$type<Agrupacion>().notNull().default({ modo: 'inmediato' }),
	/* Filas como mucho en su cola: lo que pase se descarta, primero lo de menos severidad. */
	tope: integer('tope').notNull().default(10000),
	/* Estado, que escribe el trabajador (salidas/trabajador.ts). */
	ultimoEnvio: timestamp('ultimo_envio', { withTimezone: true }),
	enviados: bigint('enviados', { mode: 'number' }).notNull().default(0),
	/* Sin secretos: se tapan antes de guardarlo. */
	ultimoError: text('ultimo_error'),
	ultimoErrorCuando: timestamp('ultimo_error_cuando', { withTimezone: true }),
	fallosSeguidos: integer('fallos_seguidos').notNull().default(0),
	/* Tras un fallo, no se vuelve a intentar hasta entonces (espera creciente). */
	siguienteIntento: timestamp('siguiente_intento', { withTimezone: true }),
	/* Quién la está atendiendo: un trabajador a la vez, aunque hubiera dos consolas. */
	trabajandoHasta: timestamp('trabajando_hasta', { withTimezone: true }),
	/* El último id del lote que se está enviando: el recorte de la cola no lo toca. */
	enVuelo: bigint('en_vuelo', { mode: 'number' }),
	descartados: jsonb('descartados').$type<Descartes>(),
	ultimoDescarte: jsonb('ultimo_descarte').$type<Descartes>(),
	ultimaPrueba: jsonb('ultima_prueba').$type<{
		cuando: string;
		quien: string;
		ok: boolean;
		detalle: string | null;
	}>(),
	creado: creado(),
	actualizado: timestamp('actualizado', { withTimezone: true }).notNull().defaultNow()
});

/*
 * La cola de cada salida. Un evento no se copia: se apunta a su fila de
 * eventos (que nunca se borra) y se lee al enviarlo. Un aviso, que no tiene
 * fila, va entero. rango es la severidad como número (baja 0 … crítica 3)
 * para recortar por ella.
 */
export const salidasCola = pgTable(
	'salidas_cola',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		salida: uuid('salida')
			.notNull()
			.references(() => salidas.id, { onDelete: 'cascade' }),
		evento: uuid('evento'),
		aviso: jsonb('aviso').$type<AvisoGuardado>(),
		severidad: text('severidad', { enum: ['baja', 'media', 'alta', 'critica'] }).notNull(),
		rango: smallint('rango').notNull(),
		creado: creado()
	},
	(t) => [
		index('salidas_cola_orden').on(t.salida, t.id),
		index('salidas_cola_recorte').on(t.salida, t.rango, t.id),
		/* Un evento entra una sola vez en cada salida. */
		uniqueIndex('salidas_cola_evento')
			.on(t.salida, t.evento)
			.where(sql`${t.evento} IS NOT NULL`),
		check('salidas_cola_contenido', sql`(${t.evento} IS NULL) <> (${t.aviso} IS NULL)`)
	]
);

/*
 * Los problemas de salud de los que ya se ha avisado (sensor:<id>,
 * trampa:<id>), para avisar solo al empezar y al acabar, también tras
 * reiniciar la consola.
 */
export const avisosSalud = pgTable('avisos_salud', {
	clave: text('clave').primaryKey(),
	codigo: text('codigo').notNull(),
	desde: timestamp('desde', { withTimezone: true }).notNull().defaultNow()
});

/* Ajustes sueltos del nodo, como la compartición de indicadores. */
export const ajustes = pgTable('ajustes', {
	clave: text('clave').primaryKey(),
	valor: jsonb('valor').notNull()
});

export const auditoria = pgTable(
	'auditoria',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		cuando: timestamp('cuando', { withTimezone: true }).notNull().defaultNow(),
		quien: text('quien').notNull(),
		accion: text('accion').notNull(),
		detalle: jsonb('detalle').$type<Record<string, unknown>>().notNull().default({})
	},
	/* Se guarda 1 año o el plazo de los eventos: el borrado de cada hora (conservacion.ts) va por fecha. */
	(t) => [index('auditoria_cuando').on(t.cuando)]
);

/*
 * Sesiones abiertas. La cookie solo lleva el id; todo lo demás está aquí, así
 * que cerrar una sesión (o todas las de alguien) surte efecto en la siguiente
 * petición. Los roles son los que traía el token de Entra al entrar.
 */
export const sesiones = pgTable('sesiones', {
	id: text('id').primaryKey(),
	oid: text('oid').notNull(),
	correo: text('correo').notNull(),
	nombre: text('nombre').notNull(),
	roles: jsonb('roles').$type<string[]>().notNull(),
	creada: creado(),
	ultimaActividad: timestamp('ultima_actividad', { withTimezone: true }).notNull().defaultNow(),
	cerrada: timestamp('cerrada', { withTimezone: true }),
	/* Técnico de SeguridadSI entrando con el acceso de soporte que abrió el cliente. */
	soporte: boolean('soporte').notNull().default(false)
});

/*
 * Llaves de emergencia (FIDO2/WebAuthn) para entrar sin Entra ni internet.
 * Se guarda la clave pública de cada llave; la privada no sale nunca de ella.
 */
export const llavesEmergencia = pgTable('llaves_emergencia', {
	id: text('id').primaryKey(),
	clavePublica: text('clave_publica').notNull(),
	contador: integer('contador').notNull().default(0),
	nombre: text('nombre').notNull(),
	registradaPor: text('registrada_por').notNull(),
	creada: creado(),
	ultimoUso: timestamp('ultimo_uso', { withTimezone: true })
});

/*
 * Usuarios locales de la consola: para los nodos que entran con usuario y
 * contraseña del propio nodo, en vez de (o además de) Entra ID. Es el «login
 * local» (docs/diseno/auth-login.md); la entrada de emergencia con llave FIDO2
 * sigue estando en los dos modos.
 *
 * La contraseña se guarda SOLO como hash scrypt (con sal por usuario), nunca en
 * claro ni cifrada de forma reversible. El freno a la fuerza bruta (intentos
 * fallidos + bloqueo temporal) vive en la fila, para que aguante reinicios del
 * nodo. La sesión que abre un usuario de aquí lleva el oid `local:<id>`.
 */
export const usuariosLocales = pgTable('usuarios_locales', {
	id: text('id').primaryKey(),
	usuario: text('usuario').notNull().unique(),
	nombre: text('nombre').notNull(),
	correo: text('correo').notNull(),
	claveHash: text('clave_hash').notNull(),
	roles: jsonb('roles').$type<string[]>().notNull(),
	/* Al primer acceso (y tras un restablecimiento) la consola obliga a cambiarla. */
	debeCambiar: boolean('debe_cambiar').notNull().default(false),
	intentosFallidos: integer('intentos_fallidos').notNull().default(0),
	bloqueadoHasta: timestamp('bloqueado_hasta', { withTimezone: true }),
	creada: creado(),
	ultimoAcceso: timestamp('ultimo_acceso', { withTimezone: true }),
	creadaPor: text('creada_por').notNull()
});
