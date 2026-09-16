# JSON/YAML Preview

A collapsible tree preview for `.json` and `.yaml`/`.yml` files, alongside the raw text.

## Contributes

- **File viewer:** `.json` files render via [react-json-view-lite](https://github.com/AnyRoad/react-json-view-lite); `.yaml`/`.yml` files are parsed with the [yaml](https://github.com/eemeli/yaml) package and rendered the same way.

## Settings

- **Click action** (`json.clickAction`, default "edit") — what a FILES-tree click on a JSON/YAML file opens: the editor, or the tree preview. The other one stays behind the hover icon and context menu.

## Notes

Bundled with Perch — disable it from the Extensions view and JSON/YAML files only ever open in the editor.
