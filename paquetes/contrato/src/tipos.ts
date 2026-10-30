/*
 * Tipos del contrato. Son espejo de los esquemas JSON de ./esquemas: el esquema
 * manda, y estos tipos solo existen para que TypeScript ayude. Si cambias uno,
 * cambia el otro; la prueba de los ejemplos lo detecta si se separan.
 */

export type Slug = string;
export type TipoTrampa = 'contenedor' | 'fichero' | 'token' | 'identidad';
export type Accion =
	| 'conexion'
	| 'autenticacion'
	| 'comando'
	| 'lectura'
	| 'escritura'
	| 'descarga'
	| 'baliza'
	| 'otra';
export type Severidad = 'baja' | 'media' | 'alta' | 'critica';

export interface Evento {
	/* La 1 llamaba "senuelo" a la trampa; validarEvento la devuelve ya como 2. */
	version: 1 | 2;
	id: string;
	cuando: string;
	trampa: { id: Slug; modulo: Slug; tipo: TipoTrampa };
	sensor: Slug;
	/*
	 * Escrito por el atacante. Nunca se pinta con {@html} ni se pasa a una shell.
	 * Salvo oculta, que la pone el sensor: la IP es la del motor, no la del atacante.
	 */
	origen: { ip?: string; puerto?: number; usuario?: string; equipo?: string; oculta?: boolean };
	accion: Accion;
	severidad: Severidad;
	conexionEstablecida: boolean;
	/* Escrito por el atacante. */
	detalle?: Record<string, unknown>;
	crudo?: string;
	hashAnterior: string;
}

export type EsquemaParametros = {
	type: 'object';
	properties: Record<string, unknown>;
	required?: string[];
};

export interface ManifiestoTrampa {
	version: 1;
	id: Slug;
	nombre: string;
	descripcion: string;
	/* Lo que ve el cliente en el catálogo: qué detecta, dónde ponerla, qué necesita y cómo se instala. */
	ficha?: {
		detecta: string;
		donde: string;
		requisitos: string[];
		instalacion: { automatica: boolean; manual?: string[] };
	};
	versionModulo: string;
	/* Sensor más viejo que sabe desplegarla: a los anteriores no se les manda. */
	sensorMinimo?: string;
	tipo: TipoTrampa;
	procedencia?: { proyecto: string; url: string; licencia: string };
	contenedor?: {
		imagen: string;
		/* De un registro público, para los sensores sin credencial del privado. La consola la manda como imagen; el sensor nunca la ve. */
		imagenPublica?: string;
		/* expuesto: un número fijo o "${parametro}"; si: el parámetro que enciende el puerto. */
		puertos: {
			interno: number;
			expuesto: number | string;
			protocolo: 'tcp' | 'udp';
			si?: string;
		}[];
		entorno?: Record<string, string | { segun: string; valores: Record<string, string> }>;
		ficheros?: { destino: string; contenido: string }[];
		escribibles?: string[];
		registros: string;
	};
	/*
	 * El modo de red «IP propia» (docs/diseno/red.md): la trampa no va en el
	 * puente aislado con NAT, sino con una IP propia en el segmento del
	 * cliente. Solo lo despliega un sensor que informa el hecho red.capa2.
	 */
	red?: RedTrampa;
	fichero?: { plantilla: string; baliza: 'dns' | 'http' | 'auditoria' };
	token?: { clase: 'aws' | 'azure' | 'url' | 'dns' };
	identidad?: { destino: 'usuario-ad' | 'spn' | 'credencial-sembrada' };
	aislamiento?: { salida: boolean; soloLectura: boolean; cpu: number; memoriaMb: number };
	parametros: EsquemaParametros;
	eventos: {
		fuente: { tipo: 'fichero' | 'rele' | 'directorio-activo'; ruta?: string };
		formato: 'json-lineas';
		campos: { cuando: string; ip?: string; puerto?: string; usuario?: string; equipo?: string };
		accion: {
			campo: string;
			valores: Record<string, Accion>;
			porDefecto: Accion;
			ignorar?: string[];
		};
		severidad: {
			porDefecto: Severidad;
			porAccion?: Partial<Record<Accion, Severidad>>;
			porValor?: Record<string, Severidad>;
			porCampo?: { campo: string; valores: Record<string, Severidad> };
		};
		conexionEstablecida: boolean;
		conexionPorCampo?: { campo: string; valores: Record<string, boolean> };
		detalle?: string[];
		/* Campo de detalle con la contraseña probada, en las trampas con login. */
		contrasena?: string;
		/* Campo de detalle que agrupa los eventos de una misma visita del atacante. */
		sesion?: string;
		/* Los campos de detalle que caben en la fila de la lista; el resto se ve al desplegarla. */
		resumen?: string[];
		/* Cómo se llaman en la consola los campos de detalle y los valores nativos de la acción. */
		etiquetas?: Record<string, string>;
	};
}

/*
 * Manifiesto v2 (docs/diseno/modulo-despliegue.md §2): una honeycosa se
 * describe una vez y se puede poner de varias maneras (vías), cada una con su
 * ejecutor, sus requisitos, su carga y por dónde vuelve su señal. Espejo de
 * esquemas/trampa-v2.schema.json. ManifiestoTrampa sigue siendo el v1, el que
 * entiende cualquier sensor.
 */

/* nombre@N: contenedor@1, manual@1… Uno que la consola no conoce no invalida el manifiesto. */
export type IdEjecutor = `${string}@${number}`;
export type TipoDestino =
	| 'maquina'
	| 'fileserver'
	| 'web'
	| 'paas-web'
	| 'hosting'
	| 'dominio'
	| 'tenant'
	| 'saas'
	| 'otro';
export type ClaseSiembra = 'servicio' | 'fichero' | 'token' | 'identidad';
export type ClaseSenal = 'directa' | 'registros' | 'baliza';

/* Todo «eventos» de v1 menos «fuente»: cómo pasar del registro nativo al evento. */
export type Traductor = Omit<ManifiestoTrampa['eventos'], 'fuente'>;

/* Lo que tiene que cumplir un evento para atribuirlo a una trampa (sin distinguir mayúsculas). */
export type Marca = {
	campo: 'origen.ip' | 'origen.usuario' | 'origen.equipo' | `detalle.${string}`;
} & ({ igual: string } | { contiene: string });

/* Por dónde vuelve la señal de una vía (§2.4). */
export type Fuente =
	| { tipo: 'fichero'; ruta: string }
	| { tipo: 'trampa'; trampa: string; marca: Marca }
	| { tipo: 'registros'; canal: 'windows-eventos' | 'syslog' | 'journald' | 'directorio-activo' }
	| { tipo: 'rele' }
	| { tipo: 'conector'; conexion: 'graph' | 'azure' | 'aws' | 'google' | 'ldap' };

export type ValorSimple = string | number | boolean;
/* Lenguaje cerrado (§3): un hecho, un solo operador y su motivo. */
export type Requisito = {
	hecho: string;
	motivo: string;
	nivel?: 'exige' | 'avisa';
	siFalta?: 'descarta' | 'avisa' | 'ignora';
	remedio?: string;
} & (
	| { igual: ValorSimple }
	| { en: ValorSimple[] }
	| { contiene: ValorSimple }
	| { minimo: string | number }
	| { presente: boolean }
);

/* texto, para el cliente, admite ${…}; orden y comprobar son código y nunca se interpolan (§6.3). */
export type Paso = { texto: string; orden?: string; comprobar?: string };

/*
 * El modo de red «IP propia» (docs/diseno/red.md). La trampa con este bloque
 * no va en el puente aislado con NAT: el sensor la pone con una IP propia en
 * el segmento del cliente (macvlan sobre la interfaz física), y solo donde el
 * hecho red.capa2 es true. Lo que puede leer del enlace (capturar) lo fija
 * este bloque: el sensor compila el filtro BPF que lo acota y solo entonces
 * concede NET_RAW. Nunca NET_ADMIN.
 */
export type RedTrampa = {
	modo: 'ip-propia';
	/*
	 * Rangos que la trampa puede leer del enlace (CIDR IPv4 separados por
	 * comas, con ${huecos} de parámetros). El sensor compila el BPF que
	 * solo deja pasar el tráfico de esos rangos y lo entrega en SD_RED_BPF.
	 * Sin capturar no se concede NET_RAW: la trampa solo tiene sus enchufes
	 * normales en su red propia.
	 */
	capturar?: string;
};

export type CargaContenedor = {
	contenedor: NonNullable<ManifiestoTrampa['contenedor']>;
	aislamiento: NonNullable<ManifiestoTrampa['aislamiento']>;
	/* El modo de red «IP propia», si la vía lo pide (solo contenedor@1). */
	red?: RedTrampa;
};
export type CargaManual = { lenguaje: 'powershell' | 'sh' | 'ninguno'; pasos: Paso[] };

export interface Via {
	id: Slug;
	nombre?: string;
	ejecutor: IdEjecutor;
	destino?: TipoDestino[];
	/* Ids que tuvo esta vía en versiones anteriores del módulo (regla 10). */
	antes?: Slug[];
	sensorMinimo?: string;
	requisitos: Requisito[];
	carga: CargaContenedor | CargaManual | Record<string, unknown>;
	senal: { fuente: Fuente; eventos?: Traductor };
	comprobacion?: {
		prueba?: { pasos: Paso[]; marca?: Marca; ventanaMin?: number };
		recomprobarDias?: number;
	};
	retirada: { tipo: 'automatica' } | { tipo: 'manual'; pasos: Paso[] };
}

/* La ficha de v1 con «instalacion» opcional: la consola la deduce de las vías. */
export type FichaV2 = Omit<NonNullable<ManifiestoTrampa['ficha']>, 'instalacion'> & {
	instalacion?: NonNullable<ManifiestoTrampa['ficha']>['instalacion'];
};

export interface ManifiestoTrampaV2 {
	version: 2;
	id: Slug;
	nombre: string;
	descripcion: string;
	ficha?: FichaV2;
	versionModulo: string;
	procedencia?: ManifiestoTrampa['procedencia'];
	siembra: { clase: ClaseSiembra };
	senal: { clase: ClaseSenal; eventos?: Traductor };
	parametros: EsquemaParametros;
	vias: Via[];
}

/* Lo que usa la consola: siempre v2, venga de un YAML v1 (origen 1) o v2 (origen 2). */
export type Honeycosa = ManifiestoTrampaV2 & { origen: 1 | 2 };

export type FamiliaRespuesta = 'avisar' | 'enviar' | 'enriquecer' | 'contener' | 'ejecutar';
export type RiesgoRespuesta = 'informativa' | 'contencion';

/*
 * La clase de un indicador de compromiso (IOC): lo que una respuesta sabe
 * atacar. Alineada con la lista negra/blanca de la consola (listas.clase) y
 * ampliada: una IP va al firewall, un dominio al antispam, un hash a Defender.
 */
export type ClaseIoc = 'ip' | 'red' | 'dominio' | 'url' | 'hash' | 'usuario' | 'equipo' | 'comando';

export interface ManifiestoRespuesta {
	version: 1;
	id: Slug;
	nombre: string;
	descripcion: string;
	versionModulo: string;
	familia: FamiliaRespuesta;
	riesgo: RiesgoRespuesta;
	ejecutor: { tipo: 'integrado'; nombre: Slug } | { tipo: 'contenedor'; imagen: string };
	entrada: Exclude<keyof Evento, 'version' | 'hashAnterior'>[];
	salida: string[];
	/*
	 * Clases de IOC sobre las que actúa. Obligatorio en contener/ejecutar (el
	 * motor crea una decisión por cada IOC del evento que encaje). Las
	 * informativas (avisar/enviar) lo omiten: actúan sobre el evento entero.
	 */
	acepta?: ClaseIoc[];
	/*
	 * `obligatorio` por defecto true: si el módulo lo declara, hace falta. Se
	 * pone en false cuando el módulo tiene varios canales y cada secreto solo lo
	 * usa uno (p. ej. abrir-ticket: `autorizacion` por API o `contrasena` por
	 * correo): el ejecutor exige en tiempo de ejecución el que toque.
	 */
	secretos?: { id: Slug; descripcion: string; obligatorio?: boolean }[];
	parametros: EsquemaParametros;
}
