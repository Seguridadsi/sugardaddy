-- Peticiones de despliegue del MCP guiado (Cloud). Tabla nueva: una consola anterior,
-- si el nodo vuelve atrás, ni la lee ni la necesita; nada de lo que ya había cambia.
CREATE TABLE "peticiones_api" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"token_nombre" text NOT NULL,
	"creador_oid" text NOT NULL,
	"creador_nombre" text NOT NULL,
	"creador_correo" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	"caduca" timestamp with time zone NOT NULL,
	"motivo" text NOT NULL,
	"objetivo" text,
	"borrador" jsonb NOT NULL,
	"estado" text DEFAULT 'pendiente' NOT NULL,
	"decidida" timestamp with time zone,
	"decidida_por" text,
	"resultado" jsonb
);
--> statement-breakpoint
CREATE INDEX "peticiones_api_token" ON "peticiones_api" USING btree ("token_id","estado");