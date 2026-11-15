-- Lo que la lista común trae y espera a entrar en el EDL por el tope diario
-- (docs/diseno/frenos-del-nodo.md). Tabla nueva: una consola anterior ni la lee.
CREATE TABLE "lista_comun_espera" (
	"valor" text PRIMARY KEY NOT NULL,
	"motivo" text NOT NULL,
	"caduca" timestamp with time zone NOT NULL,
	"recibida" timestamp with time zone DEFAULT now() NOT NULL
);
