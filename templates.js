// templates.js — bulk-import sheet schema. Single source of truth for the
// four tabs of the lander/blocks/page-views/tiles bulk-import sheet. Column
// order matches the CSV templates engineering supplied; do not reorder.

(function (global) {
  const LANDER_TEMPLATE_HEADERS = [
    'id', 'slug', 'redirect_target_id', 'canonical_id', 'type', 'state',
    'models_category_id', 'page_view_id', 'name', 'title_tag', 'query',
    'synonyms', 'discoverable', 'show_categories', 'show_categories_no_images',
    'description',
  ];

  const BLOCK_TEMPLATE_HEADERS = [
    'id', 'category_id', 'name', 'title', 'layout', 'data_type', 'query',
    'destination', 'cta', 'description', 'background_color', 'text_color',
    'visible_results', 'login_required', 'display_icon', 'active',
  ];

  const PVBR_TEMPLATE_HEADERS = [
    'id', 'page_view_id', 'block_id', 'position', 'ios', 'android', 'web', 'mobile',
  ];

  const BTR_TEMPLATE_HEADERS = [
    'id', 'tile_id', 'block_id', 'position',
  ];

  // Tab names — used as worksheet titles in the bound spreadsheet and as the
  // A1 range prefix on append/update calls. Order is the user's spec.
  const BULK_IMPORT_TABS = [
    { name: 'Landers',                     headerRow: LANDER_TEMPLATE_HEADERS },
    { name: 'Blocks',                      headerRow: BLOCK_TEMPLATE_HEADERS },
    { name: 'Page View Block Relations',   headerRow: PVBR_TEMPLATE_HEADERS },
    { name: 'Block Tile Relations',        headerRow: BTR_TEMPLATE_HEADERS },
  ];

  global.Templates = {
    LANDER_TEMPLATE_HEADERS,
    BLOCK_TEMPLATE_HEADERS,
    PVBR_TEMPLATE_HEADERS,
    BTR_TEMPLATE_HEADERS,
    BULK_IMPORT_TABS,
  };
})(window);
