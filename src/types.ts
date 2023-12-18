export type ExtensionType = 'game' | 'translation' | 'theme';

export interface IExtensionDownloadInfo {
  name?: string;
  modId?: number;
  fileId?: number;
  github?: string;
  githubRawPath?: string;
  githubRelease?: string;
}

export interface IAvailableExtension extends IExtensionDownloadInfo {
  description?: {
    short: string;
    long: string;
  };
  id?: string;
  type?: ExtensionType;
  language?: string;
  image?: string;
  author?: string;
  uploader?: string;
  version?: string;
  downloads?: number;
  endorsements?: number;
  tags?: string[];
  hide?: boolean;
  gameName?: string;
  gameId?: string;
  timestamp?: number;
  dependencies?: { [key: string]: any };
}

export interface IExtensionManifest {
  last_updated: number;
  extensions: IAvailableExtension[];
}

export interface IGitHubUser {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  gravatar_id: string;
  url: string;
  html_url: string;
  followers_url: string;
  following_url: string;
  gists_url: string;
  starred_url: string;
  subscriptions_url: string;
  organizations_url: string;
  repos_url: string;
  events_url: string;
  received_events_url: string;
  type: string;
  site_admin: boolean;
}

export interface IGitHubAsset {
  browser_download_url: string;
  content_type: string;
  created_at: string;
  download_count: number;
  id: string;
  label: any;
  name: string;
  node_id: string;
  size: number;
  state: string;
  updated_at: string;
  uploader: IGitHubUser;
  url: string;
}

export interface IGitHubRelease {
  assets: IGitHubAsset[];
  assets_url: string;
  author: IGitHubUser;
  body: string;
  created_at: string;
  draft: boolean;
  html_url: string;
  id: number;
  name: string;
  node_id: string;
  prerelease: boolean;
  published_at: string;
  tag_name: string;
  tarball_url: string;
  target_commitish: string;
  upload_url: string;
  url: string;
  zipball_url: string;
}
