import json
from google_auth_oauthlib.flow import Flow
SCOPES=["https://www.googleapis.com/auth/drive.file","https://www.googleapis.com/auth/spreadsheets"]
flow=Flow.from_client_secrets_file(".secrets/oauth_client.json",scopes=SCOPES,redirect_uri="http://localhost:8765/")
flow.autogenerate_code_verifier=True
url,state=flow.authorization_url(access_type="offline",prompt="consent")
json.dump({"state":state,"verifier":flow.code_verifier},open(".secrets/flow_state.json","w"))
print(url)
