# Vortex-Backend

## Update Extension Manifest

asdasd

## Add Extension

asdasd

## Announcements

Announcements Branch
Used to write and display official announcements within Vortex, using Vortex's in-built announcement_dashlet. The dashlet expects a specific JSON format to be adhered to in order to display these announcements correctly.

Announcement Format
All data elements are optional except for the "date" and "description" elements which are mandatory.


```json
{ 
    "date": "2019-01-14T10:20:10", 
    "description": "This is a fake announcement", 
    "link": "www.github.com", 
    "severity": "critical", 
    "gamemode": "skyrim", 
    "icon": "bug" 
}
```

- `date` - MANDATORY - Expects a valid date in ISO 8601 format.
- `description` - MANDATORY - The announcement text you wish to display.
- `link` - When a URL is provided, Vortex will generate a button for the announcement allowing the users to click and open the URL in a new webpage.
- `severity` - This element accepts one of the following: "information" | "warning" | "critical"; this will modify UI elements accordingly to highlight the severity type of the announcement. (Currently only changes the color of the announcement's icon)
- `gamemode` - Providing a specific game id will only show this announcement when actively managing the game matching the game id.
- `icon` - The name of the icon we wish to add to this announcement - When provided, Vortex will search for the icon's name within its icon selection and attempt to display it alongside the description.
- `version` - Providing a specific version number will ensure that the announcement only shows inside copies of Vortex with that specific version number.

**Please note: Upon changing the announcements.json file, it may take up to 5 minutes for the changes to be reflected within Vortex. This is probably due to some github caching mechanism or possibly just because it takes a little while for the raw page to be queryable. During this time, Vortex's requests will return the old JSON file (pre-edit).

## Survey

Array of objects used

```json
{
	"id": "vortex-sdv-feedback-1",
	"endDate": "2022-08-18T12:00:00",
	"link": "https://forms.gle/pk2vabpgCQSC4fteA",
	"gamemode": "stardewvalley"
}
```

- `id` - MANDATORY - unique id for this survey
- `endDate` - end date of survey
- `link` - link to survey
- `gamemode` - specific for a gamemode