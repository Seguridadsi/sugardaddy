/*
 * Las huellas conocidas de quien conecta, para quien-es.ts: cómo saluda por TLS
 * (JA4, JA3) y cómo negocia por SSH (HASSH). Una huella no dice quién es: dice con
 * qué biblioteca está hecho el programa. Es una pista, no una prueba; hay
 * bibliotecas que imitan el saludo de un navegador y un proxy que vuelve a cifrar
 * la conexión pone el suyo.
 *
 * De dónde salen. NINGUNA es de memoria ni copiada de una lista: se recogieron el
 * 2026-11-12 lanzando los clientes de verdad (en Docker, y los de este Mac)
 * contra un servidor que calcula la huella con el mismo código de las trampas
 * (modulos/trampas/nas/imagen/fuente/huella_tls.go) y, para SSH, con el cálculo de
 * HASSH comprobado contra un evento real de Cowrie. Al lado de cada una va el
 * cliente y la versión con que salió. Lo que no se pudo lanzar no está: mejor no
 * decir nada que decir algo sin comprobar.
 *
 * Licencias: JA4 (solo la huella TLS del cliente) es de FoxIO, BSD 3-Clause; JA3
 * y HASSH son de Salesforce, BSD 3-Clause. Aquí no hay código de ninguno: solo
 * valores observados.
 */

/* ---------------------------------------------------------------- TLS ---- */

export type FamiliaTls =
	| 'chromium'
	| 'firefox'
	| 'apple'
	| 'python'
	| 'go'
	| 'node'
	| 'java'
	| 'dotnet'
	| 'openssl'
	| 'gnutls'
	| 'libressl'
	| 'nmap';

export type HuellaTls = {
	familia: FamiliaTls;
	/* Como se dice en una frase: «the one Python produces». */
	nombre: string;
	tipo: 'navegador' | 'programa' | 'ataque';
};

const CHROMIUM: HuellaTls = {
	familia: 'chromium',
	nombre: 'Chrome (or another Chromium browser)',
	tipo: 'navegador'
};
const FIREFOX: HuellaTls = { familia: 'firefox', nombre: 'Firefox', tipo: 'navegador' };
const APPLE: HuellaTls = {
	familia: 'apple',
	nombre: 'Safari (or another Apple app)',
	tipo: 'navegador'
};
const PYTHON: HuellaTls = { familia: 'python', nombre: 'Python', tipo: 'programa' };
const GO: HuellaTls = { familia: 'go', nombre: 'Go', tipo: 'programa' };
const NODE: HuellaTls = { familia: 'node', nombre: 'Node.js', tipo: 'programa' };
const JAVA: HuellaTls = { familia: 'java', nombre: 'Java', tipo: 'programa' };
const DOTNET: HuellaTls = { familia: 'dotnet', nombre: 'PowerShell or .NET', tipo: 'programa' };
const OPENSSL: HuellaTls = {
	familia: 'openssl',
	nombre: 'OpenSSL (curl, Wget, PHP, Ruby, Perl)',
	tipo: 'programa'
};
const GNUTLS: HuellaTls = { familia: 'gnutls', nombre: 'GnuTLS (Wget)', tipo: 'programa' };
const LIBRESSL: HuellaTls = {
	familia: 'libressl',
	nombre: 'LibreSSL (curl on macOS)',
	tipo: 'programa'
};
const NMAP_TLS: HuellaTls = { familia: 'nmap', nombre: 'Nmap', tipo: 'ataque' };

/*
 * Por la segunda parte de JA4: el resumen de los cifrados que ofrece, ordenados.
 * Es lo más estable de un saludo: cada biblioteca trae su lista y no cambia con
 * el nombre del servidor, el ALPN ni la versión de la distribución, que sí mueven
 * la primera y la tercera parte. Por eso se mira esta y no la huella entera.
 */
export const JA4_CIFRADOS: Record<string, HuellaTls> = {
	/* Chromium 142 (Alpine 3.22) y 156 (Debian 13). La lista de 15 del ejemplo de la especificación de JA4. */
	'8daaf6152771': CHROMIUM,
	/* Firefox ESR 140 (Alpine 3.22), 17 cifrados; Firefox ESR 153 (Debian 13), 16 cifrados. */
	'5b57614c22b0': FIREFOX,
	'86a278354501': FIREFOX,
	/* nscurl de macOS 15.6 (CFNetwork, la red de Safari y de las apps de Apple), 20 cifrados. */
	a09f3c656075: APPLE,
	/* Python 3.12, 3.13 y 3.15: urllib, http.client, requests, httpx y aiohttp. 17 cifrados. */
	ab0a1bf427ad: PYTHON,
	/* Go 1.24, 1.25, 1.26 y 1.27: net/http. 13 cifrados. */
	f57a46bbacb6: GO,
	/* Node.js 20 (59 cifrados) y Node.js 22 y 24 (52): fetch, https y axios. */
	a33745022dd6: NODE,
	b262b3658495: NODE,
	/* Java 21 (Temurin): HttpClient y HttpsURLConnection. 31 cifrados. */
	'1d947a95fc68': JAVA,
	/* PowerShell 7.4 y 7.5 en Linux (.NET sobre OpenSSL con su lista). 12 cifrados. */
	a538d02d76d5: DOTNET,
	/* OpenSSL 3.0 a 3.3 con su lista por defecto: curl de Alpine 3.20, Debian 12 y Ubuntu 22.04 y 24.04. */
	e8f1e7e78f70: OPENSSL,
	/* OpenSSL 3.5 con su lista por defecto: curl, Ruby y Perl de Alpine 3.22, curl de Debian 13. */
	'1d37bd780c83': OPENSSL,
	/* OpenSSL con todos los cifrados: Wget de Alpine y de Ubuntu, PHP 8, y las peticiones de Nmap. */
	'8b2139ff7677': OPENSSL,
	'13e0e9e1c501': OPENSSL,
	'479067518aa3': OPENSSL,
	/* GnuTLS: Wget de Debian 12 y 13. */
	'723694b0fccc': GNUTLS,
	/* LibreSSL 3.3: el curl que trae macOS 15. */
	'0d8feac7bc37': LIBRESSL
};

/*
 * Por la tercera parte de JA4: las extensiones y los algoritmos de firma. Los
 * saludos que Nmap escribe a mano (el guion ssl-enum-ciphers, que prueba los
 * cifrados uno a uno) cambian de cifrados en cada intento pero no de extensiones.
 * Nmap 7.97.
 */
export const JA4_EXTENSIONES: Record<string, HuellaTls> = {
	'193c2c6852e3': NMAP_TLS,
	'8c62700bf2ea': NMAP_TLS,
	'33a13ba74d1c': NMAP_TLS,
	e1f06acecbdf: NMAP_TLS
};

/* Saludos enteros que no cambian: la sonda de versiones de Nmap (nmap -sV, Nmap 7.97). */
export const JA4_ENTERAS: Record<string, HuellaTls> = {
	t12i060100_eca7c5d91837_338aad02a631: NMAP_TLS
};

/*
 * JA3, por si un evento no trae JA4. Vale menos: cambia si el cliente manda o no
 * el nombre del servidor, y los navegadores barajan las extensiones en cada
 * conexión, así que de ellos no hay JA3 que valga. Solo bibliotecas, con el
 * nombre del servidor (d) y a una IP (i).
 */
export const JA3: Record<string, HuellaTls> = {
	/* Python 3.12 y 3.13 (Debian): urllib, requests, httpx y aiohttp. */
	e459f9ec156647e137eec3618527db1f: PYTHON,
	'1987606153939a4c0ccc1465ecf8e431': PYTHON,
	'86dab2109182b6bbaa644647d7db2997': PYTHON,
	'84330a279f90d61388a8bfc7cb80535f': PYTHON,
	'06873b563b993c62a40abbbdb28d2f21': PYTHON,
	'63df4a17564841f603a2c87addad697c': PYTHON,
	/* Python 3.15 (Alpine): urllib, requests, httpx y aiohttp, con nombre de servidor. */
	e8df55bdfa49d878dc07891c00a025ce: PYTHON,
	'7291ea5e449f2c7b17582541703e549d': PYTHON,
	'37f7d09ced1a845dc48872abc1a29d7b': PYTHON,
	/* Go 1.26 y 1.27: net/http con HTTP/2 (d, i) y sin él. */
	'03117a8ed39ef02427ebbc39f121275c': GO,
	'60828da5b42313d165aae2938e651b72': GO,
	'9b7dcdf3f997f1fb7b4409c94cb7ef36': GO,
	/* Node.js 22 y 24: fetch (d, i) y https (d, i). */
	d67b094811e5145139d7cea5f014309f: NODE,
	a44663b9db6ccaa680f6174478197a2f: NODE,
	'944d1e1858cd278718f8a46b65d3212f': NODE,
	e29263fb066facf0f3d23ccaf0fe19da: NODE,
	/* curl 8.14 de Alpine 3.22 (d, i). */
	'446fb8bd613d17e5d44bd3b288ac94ca': OPENSSL,
	c0d0aa2585613528b3a18d77f6675913: OPENSSL,
	/* Las peticiones de los guiones de Nmap 7.97 (Alpine 3.22), con nombre de servidor. */
	d1fbc036c01e61dd08a74292b08430d6: NMAP_TLS
};

export type Ja4 = {
	/* 13, 12, 11, 10; null si no se reconoce. */
	version: number | null;
	sni: boolean;
	cifrados: number;
	extensiones: number;
	/* «h2», «h1» (http/1.1), «00» si no ofrece ninguno. */
	alpn: string;
	b: string;
	c: string;
};

/* Parte una huella JA4 («t13d1516h2_8daaf6152771_e5627efa2ab1»); null si no lo es. */
export function leerJa4(ja4: string): Ja4 | null {
	const m =
		/^[tqd](\d\d|s\d|00)([di])(\d\d)(\d\d)([0-9a-z]{2})_([0-9a-f]{12})_([0-9a-f]{12})$/.exec(ja4);
	if (!m) return null;
	return {
		version: /^1\d$/.test(m[1]) ? Number(m[1]) : null,
		sni: m[2] === 'd',
		cifrados: Number(m[3]),
		extensiones: Number(m[4]),
		alpn: m[5],
		b: m[6],
		c: m[7]
	};
}

/* De quién es un saludo TLS, por su JA4 o, si no hay, por su JA3. */
export function huellaTlsDe(ja4: string, ja3: string): HuellaTls | null {
	const leido = leerJa4(ja4);
	if (leido) return JA4_ENTERAS[ja4] ?? JA4_CIFRADOS[leido.b] ?? JA4_EXTENSIONES[leido.c] ?? null;
	return JA3[ja3] ?? null;
}

/* ---------------------------------------------------------------- SSH ---- */

export type HuellaSsh = {
	/* Con qué se compara la versión que anuncia el cliente (la tabla SSH de quien-es.ts). */
	familia: string;
	nombre: string;
	/* cliente: lo usa una persona (OpenSSH, PuTTY…); programa: una biblioteca; ataque: una herramienta de ataque. */
	clase: 'cliente' | 'programa' | 'ataque';
};

const OPENSSH: HuellaSsh = { familia: 'openssh', nombre: 'OpenSSH', clase: 'cliente' };
const DROPBEAR: HuellaSsh = { familia: 'dropbear', nombre: 'Dropbear', clase: 'cliente' };
const PUTTY: HuellaSsh = { familia: 'putty', nombre: 'PuTTY', clase: 'cliente' };
const PARAMIKO: HuellaSsh = { familia: 'paramiko', nombre: 'Python Paramiko', clase: 'programa' };
const ASYNCSSH: HuellaSsh = { familia: 'asyncssh', nombre: 'Python AsyncSSH', clase: 'programa' };
const TWISTED: HuellaSsh = { familia: 'twisted', nombre: 'Python Twisted', clase: 'programa' };
const LIBSSH: HuellaSsh = { familia: 'libssh', nombre: 'libssh', clase: 'programa' };
const LIBSSH2: HuellaSsh = { familia: 'libssh2', nombre: 'libssh2', clase: 'programa' };
const GO_SSH: HuellaSsh = { familia: 'go', nombre: 'Go', clase: 'programa' };
const NETSSH: HuellaSsh = { familia: 'netssh', nombre: 'Ruby Net::SSH', clase: 'programa' };
const JSCH: HuellaSsh = { familia: 'jsch', nombre: 'Java JSch', clase: 'programa' };
const NMAP_SSH: HuellaSsh = { familia: 'nmap', nombre: 'Nmap', clase: 'ataque' };
const NCRACK: HuellaSsh = { familia: 'ncrack', nombre: 'Ncrack', clase: 'ataque' };

/*
 * HASSH: el MD5 de los algoritmos que ofrece el cliente al negociar (intercambio
 * de claves, cifrado, MAC y compresión), en su orden. Cowrie lo deja en `hassh`.
 * Cada biblioteca trae su lista, y OpenSSH la cambia de versión en versión.
 */
export const HASSH: Record<string, HuellaSsh> = {
	/* OpenSSH 7.4 (CentOS 7), 7.6 (Ubuntu 18.04), 8.2 (Ubuntu 20.04), 8.9 (Ubuntu 22.04), 9.2 (Debian 12). */
	ec9ea89c70f5fc71cf61061bff5e4740: OPENSSH,
	'06046964c022c6407d15a27b12a6a4fb': OPENSSH,
	c11b200866cf918393e62ea25d851d90: OPENSSH,
	e1d88fdd485f9c710074daa1fcce80a6: OPENSSH,
	'472b5de333ad665af5cbf10ff892c4df': OPENSSH,
	/* OpenSSH 9.0, 9.3 y 9.7 (Alpine 3.16, 3.18 y 3.20) y 9.6 (Ubuntu 24.04). */
	aae6b9604f6f3356543709a376d7f657: OPENSSH,
	/* OpenSSH 9.9: el de macOS 15 y el de Rocky Linux 9 (con su política de cifrado). */
	'0babd4b68a5f3757987be75fe35ad60a': OPENSSH,
	'317b06fd9a0ffa9b47354b17b71db8a3': OPENSSH,
	/* OpenSSH 10.0 (Alpine 3.22, Debian 13). */
	eeca2460550b9ded084ecf2f70a75356: OPENSSH,
	/* Dropbear 2022.82, 2022.83 y 2024.85 (Alpine 3.16 a 3.20), y 2025.88 (Alpine 3.22). */
	'16574631849ea8d13c926c9905839928': DROPBEAR,
	'818ee887e32ef97d5d172930a9c37d8d': DROPBEAR,
	/* PuTTY 0.78 (plink, Debian 12). WinSCP lleva el mismo código. */
	'10d5550e526d158ce7ad2f18cf621f66': PUTTY,
	/* Paramiko 2.12, 3.4, y 3.5 y 4.0. */
	a704be057881f0b1d623cd263e477a8b: PARAMIKO,
	'87e3d9ffee0540b0390f8a5b9c343c08': PARAMIKO,
	a2de0f306611e0957be704f5b0e35a82: PARAMIKO,
	/* AsyncSSH 2.24. */
	c70169683f416ecb6afc5aed972ec23c: ASYNCSSH,
	/* Twisted Conch 26.10. */
	'4841e64394a0f8c9bd175d10ea63a6e0': TWISTED,
	/* libssh 0.12 (ansible-pylibssh) y libssh 0.10.6, que es con lo que entra Hydra 9.4 (Debian 12). */
	'30305c9cfe5e5dea9f7bf2f1e6d500d2': LIBSSH,
	be31134219a24899a8a0c29c7797ba94: LIBSSH,
	/*
	 * libssh2 1.11.1 (ssh2-python, y los guiones ssh-brute y ssh-auth-methods de
	 * Nmap 7.97) y libssh2 1.10 (Medusa 2.2 y el sftp de curl, Debian 12).
	 */
	'57e4cc8ee36c3d78f75c6a05acd55963': LIBSSH2,
	b4b8ae3d7241d2c1dc54b4df7e8c19d1: LIBSSH2,
	/* Go, golang.org/x/crypto/ssh: la última versión y la 0.17. */
	'16443846184eafde36765c9bab2f4397': GO_SSH,
	'0a07365cc01fa9fc82608ba4019af499': GO_SSH,
	/* Ruby Net::SSH 8.1. */
	e9c043c444366a0f45141cefa92c56cc: NETSSH,
	/* JSch 0.2.23 (mwiede) y 0.1.55 (el original). */
	'0ff97bc0b684fec9ba00826c4ce4cdae': JSCH,
	'871d02a306268601bda0fc2af469da7e': JSCH,
	/* Nmap 7.97: los guiones ssh2-enum-algos y ssh-hostkey, que escriben la negociación a mano. */
	a20aced7c9824fd804f59e68dd801ad3: NMAP_SSH,
	e788c657d1a22971d5026526ffd2e918: NMAP_SSH,
	/* Ncrack 0.7 (Debian 12). Se anuncia como «SSH-2.0-OpenSSH_7.1» y no negocia como OpenSSH. */
	'55a77ae9728654f1d4240a29287dc296': NCRACK
};
