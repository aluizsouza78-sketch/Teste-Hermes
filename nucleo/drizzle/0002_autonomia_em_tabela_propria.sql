CREATE TABLE "niveis_autonomia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"servico_id" text NOT NULL,
	"nivel" text DEFAULT 'N2' NOT NULL,
	"atualizado_em" timestamp with time zone,
	CONSTRAINT "niveis_autonomia_cliente_servico_uq" UNIQUE("cliente_id","servico_id"),
	CONSTRAINT "niveis_autonomia_nivel_ck" CHECK ("niveis_autonomia"."nivel" in ('N0','N1','N2','N3'))
);
--> statement-breakpoint
ALTER TABLE "servicos_contratados" DROP CONSTRAINT "servicos_contratados_nivel_ck";--> statement-breakpoint
ALTER TABLE "niveis_autonomia" ADD CONSTRAINT "niveis_autonomia_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "niveis_autonomia" ("cliente_id", "servico_id", "nivel", "atualizado_em") SELECT "cliente_id", "servico_id", "nivel_autonomia", now() FROM "servicos_contratados" WHERE "nivel_autonomia" <> 'N2';--> statement-breakpoint
ALTER TABLE "servicos_contratados" DROP COLUMN "nivel_autonomia";