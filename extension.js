import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');
Gio._promisify(Gio.Mount.prototype, 'eject_with_operation');
Gio._promisify(Gio.Mount.prototype, 'unmount_with_operation');

const CRITICAL_PERCENT = 90;
const REFRESH_SECONDS = 60;
const BAR_WIDTH = 260;
const SYSTEM_PATH = '/';
const FULLEST = 'fullest';

// Lists the root filesystem plus every local mount (USB drives, NTFS
// partitions, etc.), the same set Nautilus shows in its sidebar.
function listDisks() {
    const disks = [{
        name: 'System',
        gicon: Gio.ThemedIcon.new('drive-harddisk-system-symbolic'),
        path: SYSTEM_PATH,
        file: Gio.File.new_for_path(SYSTEM_PATH),
        mount: null,
    }];

    for (const mount of Gio.VolumeMonitor.get().get_mounts()) {
        if (mount.is_shadowed())
            continue;
        const root = mount.get_root();
        const path = root.get_path();
        if (!path || path === SYSTEM_PATH)
            continue;
        disks.push({
            name: mount.get_name(),
            gicon: mount.get_symbolic_icon(),
            path,
            file: root,
            mount,
        });
    }
    return disks;
}

async function queryUsage(disk) {
    const info = await disk.file.query_filesystem_info_async(
        'filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, null);
    const size = info.get_attribute_uint64('filesystem::size');
    const free = info.get_attribute_uint64('filesystem::free');
    const percent = size > 0 ? Math.round(((size - free) / size) * 100) : 0;
    return {...disk, size, free, percent};
}

const DiskItem = GObject.registerClass(
class DiskItem extends PopupMenu.PopupBaseMenuItem {
    _init(disk, onEject) {
        super._init({style_class: 'diu-item'});
        this._disk = disk;
        const critical = disk.percent >= CRITICAL_PERCENT;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(box);

        const header = new St.BoxLayout({x_expand: true});
        box.add_child(header);

        header.add_child(new St.Icon({
            gicon: disk.gicon,
            style_class: 'diu-disk-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(new St.Label({
            text: disk.name,
            style_class: 'diu-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        if (disk.mount && (disk.mount.can_eject() || disk.mount.can_unmount())) {
            const eject = new St.Button({
                style_class: 'diu-eject',
                child: new St.Icon({icon_name: 'media-eject-symbolic', icon_size: 14}),
                y_align: Clutter.ActorAlign.CENTER,
            });
            eject.connect('clicked', () => onEject(disk.mount));
            header.add_child(eject);
        }

        const bar = new St.Widget({style_class: 'diu-bar'});
        bar.set_style(`width: ${BAR_WIDTH}px;`);
        const fill = new St.Widget({style_class: 'diu-bar-fill'});
        fill.set_style(`width: ${Math.round(BAR_WIDTH * disk.percent / 100)}px;`);
        if (critical)
            fill.add_style_class_name('diu-critical');
        bar.add_child(fill);
        box.add_child(bar);

        box.add_child(new St.Label({
            text: `${GLib.format_size(disk.free)} free of ${GLib.format_size(disk.size)}`,
            style_class: 'diu-free',
        }));
    }

    activate(event) {
        try {
            Gio.AppInfo.launch_default_for_uri(
                this._disk.file.get_uri(), global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError(`Could not open ${this._disk.name}`, e.message);
        }
        super.activate(event);
    }
});

const DiskIndicator = GObject.registerClass(
class DiskIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'Disk Usage Indicator');

        this._settings = settings;
        this._disks = [];
        this._settingsId = settings.connect('changed::panel-disk', () => {
            this._updatePanel(this._disks);
            this._rebuildMenu(this._disks);
        });

        this._panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._panelBox.add_child(new St.Icon({
            icon_name: 'drive-harddisk-symbolic',
            style_class: 'system-status-icon',
        }));
        this._label = new St.Label({
            text: '…',
            style_class: 'diu-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelBox.add_child(this._label);
        this.add_child(this._panelBox);

        this._refreshId = 0;
        this._queueId = 0;

        const monitor = Gio.VolumeMonitor.get();
        this._monitorIds = ['mount-added', 'mount-removed', 'mount-changed']
            .map(signal => monitor.connect(signal, () => this._queueRefresh()));
        this._monitor = monitor;

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });

        this._refresh();
    }

    // Mount signals arrive in bursts (e.g. plugging a drive), so coalesce them.
    _queueRefresh() {
        if (this._queueId)
            return;
        this._queueId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._queueId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        const id = ++this._refreshId;
        const results = await Promise.allSettled(listDisks().map(queryUsage));
        if (id !== this._refreshId || this._destroyed)
            return;

        const disks = results
            .filter(r => r.status === 'fulfilled' && r.value.size > 0)
            .map(r => r.value);
        this._disks = disks;
        this._updatePanel(disks);
        this._rebuildMenu(disks);
    }

    // The chosen disk may be unplugged; fall back to the system disk then.
    _panelDisk(disks) {
        const choice = this._settings.get_string('panel-disk');
        if (choice === FULLEST)
            return disks.reduce((a, b) => (b.percent > (a?.percent ?? -1) ? b : a), null);
        return disks.find(d => d.path === choice) ??
            disks.find(d => d.path === SYSTEM_PATH) ?? null;
    }

    _updatePanel(disks) {
        const shown = this._panelDisk(disks);
        this._label.text = shown ? `${shown.percent}%` : '';
        if (shown?.percent >= CRITICAL_PERCENT)
            this._panelBox.add_style_class_name('diu-critical');
        else
            this._panelBox.remove_style_class_name('diu-critical');
    }

    _rebuildMenu(disks) {
        this.menu.removeAll();

        if (disks.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('No disks found', {reactive: false}));
            return;
        }

        for (const disk of disks)
            this.menu.addMenuItem(new DiskItem(disk, mount => this._eject(mount)));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._buildPanelDiskMenu(disks));

        const baobab = Gio.DesktopAppInfo.new('org.gnome.baobab.desktop');
        if (baobab)
            this.menu.addAction('Disk Usage Analyzer', () => baobab.launch([], null));
    }

    _buildPanelDiskMenu(disks) {
        const shown = this._panelDisk(disks);
        const choice = this._settings.get_string('panel-disk');
        const submenu = new PopupMenu.PopupSubMenuMenuItem(
            `Show in panel: ${choice === FULLEST ? 'Fullest disk' : shown?.name ?? '—'}`);

        const options = [
            ...disks.map(d => ({label: d.name, value: d.path})),
            {label: 'Fullest disk', value: FULLEST},
        ];
        const selected = choice === FULLEST ? FULLEST : shown?.path;
        for (const {label, value} of options) {
            const item = submenu.menu.addAction(label,
                () => this._settings.set_string('panel-disk', value));
            item.setOrnament(value === selected
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        }
        return submenu;
    }

    async _eject(mount) {
        this.menu.close();
        const name = mount.get_name();
        try {
            if (mount.can_eject())
                await mount.eject_with_operation(Gio.MountUnmountFlags.NONE, null, null);
            else
                await mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, null, null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED_HANDLED))
                Main.notifyError(`Could not eject ${name}`, e.message);
        }
    }

    destroy() {
        this._destroyed = true;
        this._settings.disconnect(this._settingsId);
        this._monitorIds.forEach(id => this._monitor.disconnect(id));
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        if (this._queueId)
            GLib.source_remove(this._queueId);
        super.destroy();
    }
});

export default class DiskUsageIndicatorExtension extends Extension {
    enable() {
        this._indicator = new DiskIndicator(this.getSettings());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
