CREATE TABLE "recuperaciones_clave" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"codigo_hash" text NOT NULL,
	"origen" text NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"caduca" timestamp with time zone NOT NULL,
	"cerrada" timestamp with time zone,
	"creado" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recuperaciones_clave" ADD CONSTRAINT "recuperaciones_clave_usuario_id_usuarios_locales_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios_locales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recuperaciones_clave_usuario" ON "recuperaciones_clave" USING btree ("usuario_id","creado");