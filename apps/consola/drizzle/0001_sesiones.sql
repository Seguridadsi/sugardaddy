CREATE TABLE "sesiones" (
	"id" text PRIMARY KEY NOT NULL,
	"oid" text NOT NULL,
	"correo" text NOT NULL,
	"nombre" text NOT NULL,
	"roles" jsonb NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	"ultima_actividad" timestamp with time zone DEFAULT now() NOT NULL,
	"cerrada" timestamp with time zone
);
