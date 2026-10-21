CREATE TABLE "llaves_emergencia" (
	"id" text PRIMARY KEY NOT NULL,
	"clave_publica" text NOT NULL,
	"contador" integer DEFAULT 0 NOT NULL,
	"nombre" text NOT NULL,
	"registrada_por" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_uso" timestamp with time zone
);
