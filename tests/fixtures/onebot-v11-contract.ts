// Official OneBot v11 snapshot: botuniverse/onebot-11@d4456ee706f9ada9c2dfde56a2bcfc69752600e4.
// Independent protocol oracle for tests. Production code must not import fixtures.
export const ONEBOT_V11_REVISION = 'd4456ee706f9ada9c2dfde56a2bcfc69752600e4'
export const ONEBOT_V11_PUBLIC_ACTIONS = [
  'send_private_msg', 'send_group_msg', 'send_msg', 'delete_msg', 'get_msg', 'get_forward_msg', 'send_like',
  'set_group_kick', 'set_group_ban', 'set_group_anonymous_ban', 'set_group_whole_ban', 'set_group_admin',
  'set_group_anonymous', 'set_group_card', 'set_group_name', 'set_group_leave', 'set_group_special_title',
  'set_friend_add_request', 'set_group_add_request', 'get_login_info', 'get_stranger_info', 'get_friend_list',
  'get_group_info', 'get_group_list', 'get_group_member_info', 'get_group_member_list', 'get_group_honor_info',
  'get_cookies', 'get_csrf_token', 'get_credentials', 'get_record', 'get_image', 'can_send_image', 'can_send_record',
  'get_status', 'get_version_info', 'set_restart', 'clean_cache',
] as const
export const ONEBOT_V11_HIDDEN_ACTIONS = ['.handle_quick_operation'] as const
export const ONEBOT_V11_SEND_SEGMENTS = [
  'text', 'face', 'image', 'record', 'video', 'at', 'rps', 'dice', 'shake', 'poke', 'anonymous', 'share',
  'contact', 'location', 'music', 'reply', 'node', 'xml', 'json',
] as const
