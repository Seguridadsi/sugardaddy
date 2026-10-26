CREATE TABLE "usuarios_locales" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario" text NOT NULL,
	"nombre" text NOT NULL,
	"correo" text NOT NULL,
	"clave_hash" text NOT NULL,
	"roles" jsonb NOT NULL,
	"debe_cambiar" boolean DEFAULT false NOT NULL,
	"intentos_fallidos" integer DEFAULT 0 NOT NULL,
	"bloqueado_hasta" timestamp with time zone,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_acceso" timestamp with time zone,
	"creada_por" text NOT NULL,
	CONSTRAINT "usuarios_locales_usuario_unique" UNIQUE("usuario")
);
