CREATE TABLE "respuestas_plazos" (
	"modulo" text NOT NULL,
	"objetivo" text NOT NULL,
	"caduca" timestamp with time zone NOT NULL,
	CONSTRAINT "respuestas_plazos_modulo_objetivo_pk" PRIMARY KEY("modulo","objetivo")
);
