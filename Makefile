UUID := disk-usage-indicator@alex
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall pack

schemas/gschemas.compiled: schemas/*.gschema.xml
	glib-compile-schemas schemas

# Symlink so edits here take effect on the next shell restart (log out/in on Wayland).
install: schemas/gschemas.compiled
	mkdir -p $(dir $(DEST))
	ln -sfn $(CURDIR) $(DEST)
	@echo "Installed. Log out and back in, then run: gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -f $(DEST)

pack:
	gnome-extensions pack --force .
