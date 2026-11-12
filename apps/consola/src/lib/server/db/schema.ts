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
	PiezaPlantilla,
	Severidad
} from '@sugardaddy/contrato';

const creado = () => timestamp('creado', { withTimezone: true }).notNull().defaultNow();

export type CortafuegosNube = { proveedor: 'azure'; nsg: string };

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
	/*
	 * Cómo llama el cliente a esa red («Servidores», «Sede de Bilbao»). Lo escribe
	 * él, en el mapa o en Sensores; sin él, la red se enseña por su CIDR. También
	 * separa en el mapa dos sedes que usan el mismo rango.
	 */
	redNombre: text('red_nombre'),
	/*
	 * Dónde está este sensor, para decidir qué respuesta tiene sentido (ver
	 * lib/entorno.ts): «dentro» de la red, «perimetro-web» de cara a internet o
	 * «aislada». Es el defecto cómodo para todas sus trampas; cada honeypot puede
	 * afinarlo. Nulo = sin entorno (el motor se comporta como antes).
	 */
	entorno: text('entorno', { enum: ['dentro', 'perimetro-web', 'aislada'] }),
	/*
	 * Si se registra lo que viene de la dirección de red de la propia máquina del
	 * sensor. Por defecto no: lo suyo no es un ataque, salvo que se quiera probar a mano.
	 * Las pruebas de la consola se registran siempre. Quien lo aplica es el sensor
	 * (cmd/sensor/propio.go), porque tirar el evento en la consola rompería la cadena.
	 */
	registrarPropio: boolean('registrar_propio').notNull().default(false),
	/* sha256 del token del sensor. El token solo se ve una vez, al darlo de alta. */
	claveHash: text('clave_hash').notNull(),
	/*
	 * El token que se le ha dado al reinstalar y aún no ha usado: el anterior
	 * sigue valiendo hasta que el sensor llega con este (gestion.ts, prepararToken).
	 * Así una reinstalación que no termina no deja fuera al sensor que funciona.
	 */
	claveHashSiguiente: text('clave_hash_siguiente'),
	claveSiguienteDesde: timestamp('clave_siguiente_desde', { withTimezone: true }),
	/* Hash de la última línea aceptada: la siguiente tiene que traerlo en hashAnterior. */
	ultimoHash: text('ultimo_hash').notNull().default('0'.repeat(64)),
	ultimoLatido: timestamp('ultimo_latido', { withTimezone: true }),
	/* En otra máquina (otra VLAN, sede o nube), instalado con su propia línea. */
	remoto: boolean('remoto').notNull().default(false),
	/*
	 * La IP desde la que llega a la consola un sensor remoto, la última vista.
	 * Con el acceso a la consola limitado (docs/diseno/acceso-consola.md), su
	 * máquina tiene que estar en la lista: así se propone y se avisa si falta.
	 */
	direccion: text('direccion'),
	/*
	 * En qué IP ve a la consola la máquina de un sensor remoto que no resuelve su
	 * nombre (uno en internet, otra sede sin el DNS del cliente). La indica quien
	 * lo da de alta; su línea y su instalador fijan esa resolución sin tocar la
	 * máquina a mano (sensores-remotos.ts). Nulo: resuelve el nombre por su cuenta.
	 */
	consolaIp: text('consola_ip'),
	/*
	 * Cuándo se quitó un sensor que ya había entregado eventos: su fila se queda
	 * (la cadena de eventos tiene que seguir verificable) con el token invalidado,
	 * y en Sensores sale aparte, como retirado. Darlo de alta otra vez con el mismo
	 * identificador lo reactiva y lo deja en nulo (gestion.ts).
	 */
	retirado: timestamp('retirado', { withTimezone: true }),
	/* Versión que dice tener su actualizador; solo los remotos, el local va con el nodo. */
	version: text('version'),
	/*
	 * Las raíces en las que confía un sensor remoto para hablar con la consola:
	 * el sha256 (hex) de su ca-consola.crt, tal como lo dice su actualizador
	 * (docs/diseno/ca-nodo.md). Si no es el de las raíces que da la consola,
	 * aún no tiene la nueva y el nodo no debe cambiar de raíz sin avisarlo.
	 */
	caConfiada: text('ca_confiada'),
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
	/*
	 * El cortafuegos de la nube que tiene delante su máquina, para que la consola
	 * pueda abrir en él los puertos de sus honeypots (ficha del sensor, pestaña
	 * «Firewall»). Hoy, un grupo de seguridad de red de Azure por su id de recurso;
	 * otra nube añade su proveedor. La credencial no va aquí: es la del conector
	 * de esa nube. Nulo: no se ha indicado y se abre a mano.
	 */
	cortafuegosNube: jsonb('cortafuegos_nube').$type<CortafuegosNube>(),
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
		 * El entorno de ESTA trampa, si se afina aparte de su sensor (lib/entorno.ts).
		 * Nulo = hereda el del sensor. Gana lo más específico (trampa sobre sensor).
		 */
		entorno: text('entorno', { enum: ['dentro', 'perimetro-web', 'aislada'] }),
		/*
		 * La dirección de la máquina de su sensor, de las varias que tenga, en la
		 * que se publican sus puertos y solo en ella (una trampa de contenedor).
		 * Nula = en todas, que es lo de siempre y lo que deja una consola anterior.
		 */
		escucha: text('escucha'),
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
		/*
		 * La plantilla de la que salió (contrato, plantilla.ts), del catálogo o propia;
		 * nula si se puso suelta. Sin clave foránea: las del catálogo no están en la
		 * base, y una propia borrada deja sus trampas puestas con su grupo.
		 */
		plantilla: text('plantilla'),
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
		prueba: boolean('prueba').notNull().default(false),
		/*
		 * Lo que suma este evento a su origen para abrir un incidente
		 * (incidentes-motor.ts): los puntos de su acción según su trampa,
		 * multiplicados por su ubicación. Los de antes, 0.
		 */
		puntos: integer('puntos').notNull().default(0),
		/*
		 * Lo pidió un escáner conocido: el id de su proveedor ($lib/escaner.ts). Solo lo pone
		 * el clasificador (escaneres.ts), por la IP de la conexión. Se guarda y se ve con su
		 * etiqueta, pero no es un ataque: no abre incidente, no pasa a Respuesta ni a las
		 * salidas, no entra en los recuentos del perfil de esa IP y no se comparte. La línea
		 * firmada no se toca. La consola anterior no la escribe: null.
		 */
		escaner: text('escaner')
	},
	(t) => [
		uniqueIndex('eventos_hash').on(t.hash),
		index('eventos_cuando').on(t.cuando),
		index('eventos_trampa').on(t.trampa),
		index('eventos_contrasena').on(t.contrasena),
		index('eventos_ip').on(t.ip),
		/* El perfil de una IP (perfilDeIp) pide sus eventos por fecha: (ip, cuando) hace el ORDER BY … LIMIT sin ordenar todo el rango. */
		index('eventos_ip_cuando').on(t.ip, t.cuando),
		/* Incidentes (incidentes.ts) agrupa y abre la línea de tiempo por usuario. */
		index('eventos_usuario').on(t.usuario),
		/* El perfil de un usuario (perfilDeUsuario) pide sus eventos por fecha, como el de IP. */
		index('eventos_usuario_cuando').on(t.usuario, t.cuando),
		/* El borrado por plazo de conservación (conservacion.ts) va por «recibido». */
		index('eventos_recibido').on(t.recibido),
		/* Lo apartado se cuenta y se filtra por proveedor, y es muy poco: solo esas filas. */
		index('eventos_escaner')
			.on(t.escaner, t.recibido)
			.where(sql`${t.escaner} is not null`)
	]
);

/*
 * «Probar» una trampa (docs/diseno/modulo-despliegue.md §8.3, §9.2): una
 * ventana de unos minutos en la que cuenta como prueba un evento de la
 * trampa, o de la trampa que recibe su señal si la activa, recibido (reloj
 * de la consola) entre «desde» y «hasta» más 2 minutos, que cumpla «marca»
 * o, si la prueba no tiene, venga de una de sus «ips». «evento» es el primero
 * que llegó.
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
		/*
		 * La primera de «ips». Es lo que lee una consola anterior a «ips»: se
		 * sigue escribiendo para que esa consola reconozca la prueba si el nodo
		 * vuelve atrás tras actualizarse.
		 */
		ip: text('ip'),
		/*
		 * Sin marca, las IPs de las que puede venir su evento: la que dice quien
		 * prueba o, en «Prueba mi detección», las que puede llevar el toque desde
		 * el nodo (prueba-deteccion.ts). Nula en las de una consola anterior, que
		 * solo tienen «ip».
		 */
		ips: text('ips').array(),
		marca: jsonb('marca').$type<Marca>(),
		desde: timestamp('desde', { withTimezone: true }).notNull().defaultNow(),
		hasta: timestamp('hasta', { withTimezone: true }).notNull(),
		evento: uuid('evento'),
		quien: text('quien').notNull()
	},
	(t) => [index('pruebas_abiertas').on(t.trampa, t.hasta)]
);

/*
 * Las conexiones de prueba de «Prueba mi detección» que hace el sensor
 * (toques.ts): se le dan una vez, con su plan, y cuenta cómo han ido. Lo que
 * dice que un evento es de la prueba es el código que el sensor pone en él (la
 * marca de la prueba), no estas filas.
 */
export const toques = pgTable(
	'toques',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		prueba: uuid('prueba')
			.notNull()
			.references(() => pruebas.id, { onDelete: 'cascade' }),
		sensor: text('sensor')
			.notNull()
			.references(() => sensores.id, { onDelete: 'cascade' }),
		trampa: text('trampa').notNull(),
		direccion: text('direccion').notNull(),
		puerto: integer('puerto').notNull(),
		codigo: text('codigo').notNull(),
		/* Las IPs de su máquina con las que puede llegar a la trampa. */
		ips: text('ips').array().notNull(),
		pedido: timestamp('pedido', { withTimezone: true }).notNull().defaultNow(),
		/* Cuándo se le dio al sensor. Nulo: aún no ha pedido su plan. */
		entregado: timestamp('entregado', { withTimezone: true }),
		/* Cómo fue: nulo hasta que lo cuenta. */
		ok: boolean('ok'),
		detalle: text('detalle')
	},
	(t) => [
		index('toques_pendientes')
			.on(t.sensor)
			.where(sql`${t.entregado} IS NULL`)
	]
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
		 * La segunda URL del documento, la del relé, cuando lleva también la del
		 * receptor de la red (en url): una apertura puede dar dos señales y solo vale una
		 * (docs/diseno/rele-balizas.md). Nula en todas las demás, también las de antes.
		 */
		urlRele: text('url_rele'),
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
		/* Clase «vigia»: el último «sigo vivo» de la tarea del servidor vigilado. */
		ultimoVivo: timestamp('ultimo_vivo', { withTimezone: true }),
		/*
		 * Clase «vigia» (EVT-1): la clave con que la tarea del servidor vigilado firma sus
		 * avisos, cifrada con la del nodo (secretos.ts, contexto «baliza:<token>»). Va en la
		 * configuración de la tarea, nunca en la URL. Nula en las de antes y en las demás clases.
		 */
		clave: text('clave'),
		/*
		 * Si un aviso sin firma buena va a la cuarentena: desde el alta en las que nacen con
		 * clave; en las de antes que la reciben al repetir sus pasos, desde su primer aviso
		 * firmado (hasta entonces la tarea vieja sigue avisando sin firmar).
		 */
		firmaExigida: boolean('firma_exigida').notNull().default(false),
		creado: creado()
	},
	(t) => [uniqueIndex('balizas_trampa').on(t.trampa), index('balizas_sensor').on(t.sensor)]
);

/*
 * Los nonces de los avisos firmados de los vigías ya recibidos (EVT-1): un aviso con
 * firma buena que repite el nonce de otro de su baliza es una copia y va a la
 * cuarentena. La hora es la que firmó la tarea; se borran a la semana de ella.
 */
export const noncesVigia = pgTable(
	'nonces_vigia',
	{
		token: text('token')
			.notNull()
			.references(() => balizas.token, { onDelete: 'cascade' }),
		nonce: text('nonce').notNull(),
		hora: timestamp('hora', { withTimezone: true }).notNull()
	},
	(t) => [
		primaryKey({ columns: [t.token, t.nonce] }),
		index('nonces_vigia_hora').on(t.token, t.hora)
	]
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
	/* null: todos los entornos; si no, solo los eventos de trampas de estos entornos (lib/entorno.ts). */
	entornos: jsonb('entornos').$type<string[] | null>(),
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
/*
 * Hasta cuándo dura un bloqueo, para los sistemas donde no se puede anotar junto
 * a él: una ubicación con nombre de Entra solo guarda rangos, sin comentarios
 * (en un Fortigate o un NSG la fecha va en el propio objeto). Solo hay fila de
 * lo que ha puesto el nodo: lo que puso otra persona no caduca nunca.
 */
export const respuestasPlazos = pgTable(
	'respuestas_plazos',
	{
		modulo: text('modulo').notNull(),
		objetivo: text('objetivo').notNull(),
		caduca: timestamp('caduca', { withTimezone: true }).notNull()
	},
	(t) => [primaryKey({ columns: [t.modulo, t.objetivo] })]
);

export const respuestasConfig = pgTable('respuestas_config', {
	modulo: text('modulo').primaryKey(),
	parametros: jsonb('parametros').$type<Record<string, unknown>>().notNull().default({}),
	secretosCifrados: text('secretos_cifrados'),
	/*
	 * Si el cliente ha activado este módulo. El motor solo ofrece y ejecuta un
	 * módulo con activa=true (sus credenciales completas se exigen al guardar):
	 * sin activar, no actúa (falla cerrado). Aditiva y con DEFAULT: la consola
	 * anterior, que ni la lee ni la escribe, cae en false y sigue igual.
	 */
	activa: boolean('activa').notNull().default(false),
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

/*
 * Qué manda una salida. Los avisos de salud y los de Respuesta van todos o
 * ninguno: son pocos y del nodo entero. Va en jsonb: los campos nuevos son
 * opcionales y la consola anterior, que no los conoce, los ignora (sin
 * entornos manda de todas las ubicaciones, que es lo que hacía).
 */
export type ReglasSalida = {
	/* Los eventos de las trampas, con estos filtros. */
	eventos: boolean;
	severidadMinima: Severidad;
	/* null: todas las trampas, también las que se pongan después. */
	trampas: string[] | null;
	/* null: todas las acciones. */
	acciones: Accion[] | null;
	/*
	 * null o sin poner: de cualquier ubicación. Si no, solo los eventos de
	 * trampas de estas ubicaciones (lib/entorno.ts: dentro, perimetro-web,
	 * aislada), las mismas que acotan las reglas de Respuesta.
	 */
	entornos?: string[] | null;
	/* Sensor sin latido, trampa caída o parada, cola de otra salida llena. */
	salud: boolean;
	/*
	 * Lo que hace Respuesta: contención ejecutada, simulada, pendiente de
	 * aprobación, fallida o parada por las guardas (respuesta/avisos.ts). Sin
	 * poner (una salida de antes de la casilla) cuenta como sí.
	 */
	respuesta?: boolean;
	/*
	 * Los incidentes (incidentes-motor.ts): uno al abrirse, sus novedades
	 * agrupadas y el resumen al cerrarse. Sin poner (una salida de antes de la
	 * casilla) cuenta como sí.
	 */
	incidentes?: boolean;
	/* El resumen de la semana, los lunes (resumen-semanal.ts). Sin poner, no. */
	resumenSemanal?: boolean;
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
	/* salud.sensor-sin-latido, salud.trampa-caida, salida.cola-llena, salida.prueba, respuesta.ejecutada… */
	codigo: string;
	titulo: string;
	texto: string;
	/* respuesta: el id es la ejecución (o la aprobación) y el nombre, el de su regla. */
	sobre?: {
		tipo: 'sensor' | 'trampa' | 'salida' | 'respuesta' | 'incidente' | 'pentest';
		id: string;
		nombre: string;
	};
	/*
	 * De dónde viene, para el alcance por niveles (lib/alcance.ts), cuando no lo
	 * dice «sobre»: los honeypots que toca. No va a los SIEM: es solo para repartir.
	 */
	origen?: { trampas?: string[]; sensor?: string };
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
 * El alcance de cada salida por niveles (lib/alcance.ts): lo que un sensor o un
 * honeypot dice de un canal, sí o no. Solo hay fila si lo dice; heredar es no
 * tener fila. Sin claves a sensores ni a trampas, como el resto de estas tablas:
 * la consola anterior los borra sin más, y una fila huérfana no hace nada.
 */
export const salidasAlcance = pgTable(
	'salidas_alcance',
	{
		salida: uuid('salida')
			.notNull()
			.references(() => salidas.id, { onDelete: 'cascade' }),
		nivel: text('nivel', { enum: ['sensor', 'trampa'] }).notNull(),
		/* El id del sensor o del honeypot. */
		objeto: text('objeto').notNull(),
		envia: boolean('envia').notNull(),
		quien: text('quien'),
		cambiado: timestamp('cambiado', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.salida, t.nivel, t.objeto] })]
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

/*
 * Enriquecimiento de la IP pública de origen (país, operador y reputación de
 * AbuseIPDB y GreyNoise), cacheado por IP con un TTL. Tabla nueva y sin claves
 * hacia las de antes: la consola anterior no la ve y sigue igual. Solo la
 * escribe quien abre el detalle de un evento (enriquecimiento.ts), nunca la
 * recepción de eventos.
 */
export const enriquecimientoIp = pgTable('enriquecimiento_ip', {
	ip: text('ip').primaryKey(),
	pais: text('pais'),
	operador: text('operador'),
	puntuacion: integer('puntuacion'),
	clasificacion: text('clasificacion'),
	totalInformes: integer('total_informes'),
	tor: boolean('tor').notNull().default(false),
	fuentes: jsonb('fuentes').$type<string[]>().notNull().default([]),
	crudo: jsonb('crudo').$type<Record<string, unknown>>().notNull().default({}),
	cuando: timestamp('cuando', { withTimezone: true }).notNull().defaultNow()
});

/*
 * Lo que el sensor sube de verdad de una visita a cowrie: el binario que
 * capturó la trampa, o el ttylog para repetir la sesión byte a byte. Cuelga del
 * evento que lo trajo y se va con él al caducar (ON DELETE CASCADE). HOY está
 * vacía: el sensor de cowrie solo sube cowrie.json (los eventos), no el
 * contenido de los ficheros ni el ttylog; esta tabla es donde aterrizará ese
 * contenido cuando se conecte ese tramo (captura-artefactos.ts). Mientras
 * tanto, la sesión se arma con lo que cowrie ya reporta (captura.ts).
 */
export const artefactos = pgTable(
	'artefactos',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		evento: uuid('evento')
			.notNull()
			.references(() => eventos.id, { onDelete: 'cascade' }),
		tipo: text('tipo', { enum: ['descarga', 'escritura'] }).notNull(),
		nombre: text('nombre'),
		sha256: text('sha256'),
		bytes: bigint('bytes', { mode: 'number' }),
		/* Dónde está la copia subida por el sensor; null mientras no haya copia. */
		ref: text('ref'),
		creado: creado()
	},
	(t) => [index('artefactos_evento').on(t.evento)]
);

/*
 * El triaje de un evento: la marca que le pone quien lo revisa (revisado,
 * falso positivo, interesante) y una nota. Es metadato del operador, aparte de
 * la línea firmada (que no se toca); se va con el evento al caducar (FK ON
 * DELETE CASCADE). Un triaje por evento (PK = evento).
 */
export const triaje = pgTable(
	'triaje',
	{
		evento: uuid('evento')
			.primaryKey()
			.references(() => eventos.id, { onDelete: 'cascade' }),
		estado: text('estado', {
			enum: ['revisado', 'falso-positivo', 'interesante']
		}).notNull(),
		nota: text('nota'),
		quien: text('quien').notNull(),
		cuando: timestamp('cuando', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('triaje_estado').on(t.estado)]
);

/*
 * Silenciar ruido: una IP o un rango (CIDR) que durante un tiempo no genera
 * avisos ni respuesta (el evento se sigue guardando y se ve en la consola).
 * Baja la fatiga de alertas con escáneres y fuentes conocidas. Es de pago (muda
 * los avisos/SIEM y el motor de respuesta, que lo son); la edición community no
 * la usa. El patrón se compara en memoria al recibir (salidas/silencios.ts).
 */
export const silencios = pgTable(
	'silencios',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/* IP exacta o CIDR (IPv4 o IPv6). */
		patron: text('patron').notNull(),
		/*
		 * «Para siempre» es PARA_SIEMPRE (silencios.ts), una fecha del año 9999,
		 * y no un nulo: así una consola anterior lo sigue leyendo como uno que
		 * aún no ha vencido. Se quita a mano, como los demás.
		 */
		hasta: timestamp('hasta', { withTimezone: true }).notNull(),
		motivo: text('motivo'),
		quien: text('quien').notNull(),
		creado: creado()
	},
	(t) => [index('silencios_hasta').on(t.hasta)]
);

/*
 * Reglas de triaje automático (gratis): patrones que marcan solos los eventos
 * NUEVOS que casan, para que el operador no triaje a mano lo repetitivo (un
 * escáner conocido como falso positivo, una IP propia como revisada, un usuario
 * de pruebas…). Se aplican al recibir el evento (lib/server/triaje-auto.ts),
 * nunca al histórico (forward-only). Metadato del operador, aparte de la línea
 * firmada. Tabla nueva y sin que nadie más la referencie: la consola anterior,
 * a la que vuelve el actualizador sin restaurar la base de datos, ni la ve.
 */
export const reglasTriaje = pgTable(
	'reglas_triaje',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/* Qué campo del evento mira la regla. */
		criterio: text('criterio', { enum: ['ip', 'usuario', 'comando', 'trampa'] }).notNull(),
		/*
		 * El patrón, según el criterio: una IP o un CIDR (ip), un texto a buscar
		 * (usuario exacto; comando, dentro de lo que tecleó o envió el atacante) o
		 * el id de una trampa (trampa).
		 */
		valor: text('valor').notNull(),
		/* Con qué estado se marca el evento que casa. */
		estado: text('estado', {
			enum: ['revisado', 'falso-positivo', 'interesante']
		}).notNull(),
		/* La nota que se le pone al triaje (opcional). */
		nota: text('nota'),
		activa: boolean('activa').notNull().default(true),
		quien: text('quien').notNull(),
		creado: creado()
	},
	(t) => [index('reglas_triaje_activa').on(t.activa)]
);

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

/*
 * Lo que cada persona elige para sí, entre por donde entre: se cuelga del oid de
 * la sesión (`local:<id>`, `emergencia:<id>` o el de Entra), porque quien entra
 * con Entra no tiene fila propia en el nodo. No lleva clave ajena a
 * `usuarios_locales` por eso mismo: al retirar un usuario local, la borra `retirar`.
 *
 * `zonaHoraria` nula: sigue la del navegador (lib/server/zona-horaria.ts).
 */
export const preferenciasUsuario = pgTable('preferencias_usuario', {
	oid: text('oid').primaryKey(),
	zonaHoraria: text('zona_horaria'),
	actualizada: timestamp('actualizada', { withTimezone: true }).notNull().defaultNow()
});

/*
 * Códigos para recuperar la contraseña de un usuario local (auth/recuperar.ts).
 * Solo el hash del código; caduca, aguanta pocos intentos y se cierra al usarlo
 * o al pedir otro. Origen «correo»: lo pidió alguien en /sign-in/recover.
 */
export const recuperacionesClave = pgTable(
	'recuperaciones_clave',
	{
		id: text('id').primaryKey(),
		usuarioId: text('usuario_id')
			.notNull()
			.references(() => usuariosLocales.id, { onDelete: 'cascade' }),
		codigoHash: text('codigo_hash').notNull(),
		origen: text('origen').notNull(),
		intentos: integer('intentos').notNull().default(0),
		caduca: timestamp('caduca', { withTimezone: true }).notNull(),
		/* Usado, o anulado al pedir otro. */
		cerrada: timestamp('cerrada', { withTimezone: true }),
		creada: creado()
	},
	(t) => [index('recuperaciones_clave_usuario').on(t.usuarioId, t.creada)]
);

/*
 * Incidentes por puntos (incidentes-motor.ts): un origen haciendo algo, con
 * principio y fin. Se abre al tocar una trampa que siempre es ataque, una
 * interna, o al pasar el umbral de puntos en una hora; se cierra tras una hora
 * sin actividad. Como mucho uno abierto por origen.
 */
export const incidentesAbiertos = pgTable(
	'incidentes_motor',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/* La IP del origen. */
		origen: text('origen').notNull(),
		estado: text('estado', { enum: ['abierto', 'cerrado'] })
			.notNull()
			.default('abierto'),
		/* Por qué se abrió: siempre, credencial, interno o umbral. */
		motivo: text('motivo').notNull(),
		severidad: text('severidad', { enum: ['baja', 'media', 'alta', 'critica'] }).notNull(),
		puntos: integer('puntos').notNull().default(0),
		eventos: integer('eventos').notNull().default(0),
		/* Las trampas que ha tocado (ids). */
		trampas: jsonb('trampas').$type<string[]>().notNull().default([]),
		/* El primer y el último evento (reloj del sensor). */
		primero: timestamp('primero', { withTimezone: true }).notNull(),
		ultimo: timestamp('ultimo', { withTimezone: true }).notNull(),
		/* La última vez que llegó algo suyo (reloj de la consola): decide el cierre. */
		actividad: timestamp('actividad', { withTimezone: true }).notNull().defaultNow(),
		abierto: timestamp('abierto', { withTimezone: true }).notNull().defaultNow(),
		cerrado: timestamp('cerrado', { withTimezone: true }),
		/* La última vez que se avisó (abrir o novedades) y lo que ha llegado desde entonces. */
		avisado: timestamp('avisado', { withTimezone: true }),
		pendientes: integer('pendientes').notNull().default(0),
		/* Alguien contestó desde el aviso (lo-miro, bloqueada o es-mio): ya no se escala. */
		atendido: timestamp('atendido', { withTimezone: true }),
		atendidoPor: text('atendido_por'),
		atendidoComo: text('atendido_como'),
		/* Hasta qué cambio lo tiene el panel, si el cliente comparte sus incidentes (vigilancia.ts). */
		subido: timestamp('subido', { withTimezone: true }),
		/* La última vez que se escaló por falta de respuesta, y cuántas van. */
		escalado: timestamp('escalado', { withTimezone: true }),
		escalados: integer('escalados').notNull().default(0),
		/*
		 * Ninguna conexión ha venido de esta IP: salió del cuerpo de un POST, que escribe
		 * cualquiera con el token. El aviso lo dice y no ofrece bloquearla. La consola
		 * anterior no la escribe: false, como hasta ahora.
		 */
		sinConexion: boolean('sin_conexion').notNull().default(false),
		/*
		 * Cuándo lo aceptó el panel de SeguridadSI, si se escala hasta allí. Aparte de
		 * «escalados», que cuenta los avisos al cliente: lo que no quepa en una vuelta o el
		 * panel no acepte se vuelve a intentar en la siguiente.
		 */
		alPanel: timestamp('al_panel', { withTimezone: true }),
		/*
		 * La frase de por qué puede ser un escáner, aunque no se haya apartado
		 * (indicioDeEscaner): el User-Agent, que cualquiera escribe, o una red de un servicio
		 * que nadie documenta como escáner. Solo informa: el incidente se abre igual. Se borra
		 * en cuanto llega algo suyo que no lo parece. La consola anterior no la escribe: null.
		 */
		posibleEscaner: text('posible_escaner')
	},
	(t) => [
		/* Uno abierto por origen: dos entregas a la vez no abren dos. */
		uniqueIndex('incidentes_motor_abierto')
			.on(t.origen)
			.where(sql`${t.estado} = 'abierto'`),
		index('incidentes_motor_estado').on(t.estado, t.actividad),
		index('incidentes_motor_abierto_en').on(t.abierto)
	]
);

/*
 * Orígenes conocidos (origenes.ts): lo tuyo que toca las trampas —un escáner,
 * la monitorización, un administrador—. Junta lo que antes eran la lista
 * blanca de IP y redes, silenciar ruido y las reglas de triaje por IP: sus
 * eventos se guardan, pero no abren incidentes ni avisan, Respuesta no los
 * toca, se marcan revisados y no se comparten. Con horario, solo cuenta dentro
 * de él (el escáner de los lunes a las 3).
 */
export type HorarioOrigen = {
	/* 1 lunes … 7 domingo; vacío o sin poner, todos. */
	dias: number[];
	/* HH:MM en la zona; si hasta < desde, cruza la medianoche. */
	desde: string;
	hasta: string;
	zona: string;
};

export const origenesConocidos = pgTable(
	'origenes_conocidos',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		nombre: text('nombre').notNull(),
		/* Una IP o una red (CIDR), IPv4 o IPv6. */
		patron: text('patron').notNull(),
		horario: jsonb('horario').$type<HorarioOrigen>(),
		/* Sin poner, para siempre. */
		caduca: timestamp('caduca', { withTimezone: true }),
		activo: boolean('activo').notNull().default(true),
		nota: text('nota'),
		/* manual, es-mio, propuesta o migrado-blanca/-silencio/-triaje. */
		procedencia: text('procedencia').notNull().default('manual'),
		quien: text('quien').notNull(),
		creado: timestamp('creado', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('origenes_conocidos_activo').on(t.activo)]
);

/*
 * Modo pentest (pentest.ts): una ventana en la que lo que llega de las IP del
 * equipo de pentest (o de cualquiera, sin IP) se guarda sin avisar, sin abrir
 * incidentes y sin que Respuesta lo bloquee. Al terminar se hace su informe.
 */
export type InformePentest = {
	eventos: number;
	primero: string | null;
	ultimo: string | null;
	porIp: { ip: string; eventos: number; trampas: number }[];
	porTrampa: { trampa: string; nombre: string; eventos: number }[];
	porAccion: Record<string, number>;
	porSeveridad: Record<string, number>;
	usuarios: { usuario: string; veces: number }[];
	credenciales: number;
	comandos: number;
	/* Las trampas puestas que no tocó: lo que su reconocimiento no encontró. */
	noTocadas: { trampa: string; nombre: string }[];
	/* Con IP declaradas, lo que llegó de otras en la ventana (eso sí avisó). */
	otras: { ip: string; eventos: number }[];
};

export const ventanasPentest = pgTable(
	'ventanas_pentest',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		nombre: text('nombre').notNull(),
		/* IP o redes del equipo de pentest; vacío, todas. */
		ips: jsonb('ips').$type<string[]>().notNull().default([]),
		desde: timestamp('desde', { withTimezone: true }).notNull(),
		hasta: timestamp('hasta', { withTimezone: true }).notNull(),
		nota: text('nota'),
		quien: text('quien').notNull(),
		creado: timestamp('creado', { withTimezone: true }).notNull().defaultNow(),
		/* Cuándo se avisó de que empezaba (nulo: aún no). */
		avisadoInicio: timestamp('avisado_inicio', { withTimezone: true }),
		/* El informe, hecho al terminar (nulo: aún no). */
		informe: jsonb('informe').$type<InformePentest>(),
		terminado: timestamp('terminado', { withTimezone: true })
	},
	(t) => [index('ventanas_pentest_hasta').on(t.hasta)]
);

/*
 * Los enlaces de los botones de un aviso (enlaces-aviso.ts) que ya se han
 * usado: cada uno vale una vez. Se guarda la huella del enlace, no el enlace.
 */
export const enlacesUsados = pgTable('enlaces_usados', {
	huella: text('huella').primaryKey(),
	incidente: uuid('incidente').notNull(),
	accion: text('accion').notNull(),
	quien: text('quien').notNull(),
	usado: timestamp('usado', { withTimezone: true }).notNull().defaultNow()
});

/*
 * Las plantillas propias del cliente (contrato, plantilla.ts): grupos de trampas que
 * monta desde el constructor, en la edición Cloud. Las del catálogo no están
 * aquí: viajan en modulos/plantillas. El id empieza por «custom-».
 */
export const plantillas = pgTable('plantillas', {
	id: text('id').primaryKey(),
	nombre: text('nombre').notNull(),
	descripcion: text('descripcion').notNull(),
	entorno: text('entorno'),
	piezas: jsonb('piezas').$type<PiezaPlantilla[]>().notNull(),
	quien: text('quien').notNull(),
	creado: creado(),
	cambiado: timestamp('cambiado', { withTimezone: true }).notNull().defaultNow()
});
