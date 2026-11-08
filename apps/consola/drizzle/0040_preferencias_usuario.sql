CREATE TABLE "preferencias_usuario" (
	"oid" text PRIMARY KEY NOT NULL,
	"zona_horaria" text,
	"actualizada" timestamp with time zone DEFAULT now() NOT NULL
);
