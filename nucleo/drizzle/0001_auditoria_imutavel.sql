CREATE FUNCTION proibir_alteracao() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% é somente inserção', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER auditoria_imutavel_update BEFORE UPDATE ON auditoria FOR EACH ROW EXECUTE FUNCTION proibir_alteracao();
--> statement-breakpoint
CREATE TRIGGER auditoria_imutavel_delete BEFORE DELETE ON auditoria FOR EACH ROW EXECUTE FUNCTION proibir_alteracao();
--> statement-breakpoint
CREATE TRIGGER decisoes_politica_imutavel_update BEFORE UPDATE ON decisoes_politica FOR EACH ROW EXECUTE FUNCTION proibir_alteracao();
--> statement-breakpoint
CREATE TRIGGER decisoes_politica_imutavel_delete BEFORE DELETE ON decisoes_politica FOR EACH ROW EXECUTE FUNCTION proibir_alteracao();
