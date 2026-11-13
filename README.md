## Introduction
This is a project for CSCE 4350, presenting an auto parts store and interfacing database system. The code for the backend can be found in this repo, and the website can be found here:
>[!INSERT WEBSITE LINK]

## Running the demo locally
The Flask API (`api/`) serves both the JSON endpoints under `/api` and the demo website (`web/`) at `/`.

```bash
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m api.app
```

Then open http://localhost:5000. The API reads `AWESOME_AUTOPARTS.db` from the project root; set the `AUTOPARTS_DB` environment variable to use a different file.

- **Shop** (customer mode): browse/search the catalog, see stock per store, cart and checkout, account and order history.
- **Staff** (employee mode): reports dashboard, inventory manager, customer orders, supplier deliveries, employee directory (managers only).

Both sign-in screens include a demo shortcut that loads a sample account without a password, since the sample data's passwords are hashed.


## Credits
Backend python scripts and database construction: Sean Neely
Website design: Cooper [[LASTNAME]]
Frontend code: Mason ~~Stone~~ Liley
