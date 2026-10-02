; NSIS installer hooks (bundle.windows.nsis.installerHooks).
;
; On Windows a bundle file association makes edit2 the default app for the
; extension, so tauri.windows.conf.json only associates Markdown. Every other
; format is added to Explorer's "Open with" list instead, leaving .html, .svg,
; .json and the rest with the browser or editor the user already has.
; `npm run build` checks these extensions against the format plugins.

!define EDIT2_PROGID "edit2.File"

!macro EDIT2_OPEN_WITH_EXTS MACRO
  !insertmacro ${MACRO} "txt"
  !insertmacro ${MACRO} "text"
  !insertmacro ${MACRO} "log"
  !insertmacro ${MACRO} "json"
  !insertmacro ${MACRO} "jsonc"
  !insertmacro ${MACRO} "json5"
  !insertmacro ${MACRO} "geojson"
  !insertmacro ${MACRO} "webmanifest"
  !insertmacro ${MACRO} "yaml"
  !insertmacro ${MACRO} "yml"
  !insertmacro ${MACRO} "toml"
  !insertmacro ${MACRO} "xml"
  !insertmacro ${MACRO} "svg"
  !insertmacro ${MACRO} "plist"
  !insertmacro ${MACRO} "xsd"
  !insertmacro ${MACRO} "xsl"
  !insertmacro ${MACRO} "xslt"
  !insertmacro ${MACRO} "rss"
  !insertmacro ${MACRO} "atom"
  !insertmacro ${MACRO} "csv"
  !insertmacro ${MACRO} "tsv"
  !insertmacro ${MACRO} "tab"
  !insertmacro ${MACRO} "html"
  !insertmacro ${MACRO} "htm"
!macroend

!macro EDIT2_ADD_OPEN_WITH EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${EDIT2_PROGID}" ""
!macroend

!macro EDIT2_REMOVE_OPEN_WITH EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${EDIT2_PROGID}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\${EDIT2_PROGID}" "" "edit2 Document"
  WriteRegStr SHCTX "Software\Classes\${EDIT2_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${EDIT2_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  !insertmacro EDIT2_OPEN_WITH_EXTS EDIT2_ADD_OPEN_WITH
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro EDIT2_OPEN_WITH_EXTS EDIT2_REMOVE_OPEN_WITH
  DeleteRegKey SHCTX "Software\Classes\${EDIT2_PROGID}"
  !insertmacro UPDATEFILEASSOC
!macroend
