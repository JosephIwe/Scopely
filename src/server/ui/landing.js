// Links made before the product moved to /app (for example /#/p/12) still open: the part after the
// hash only ever named an app screen, so it is carried over unchanged.
if (/^#\/./.test(location.hash)) location.replace(`/app${location.hash}`);
