import json,sys,os
os.environ["OAUTHLIB_INSECURE_TRANSPORT"]="1"
os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"]="1"
from google_auth_oauthlib.flow import Flow
SCOPES=["https://www.googleapis.com/auth/drive.file","https://www.googleapis.com/auth/spreadsheets"]
st=json.load(open(".secrets/flow_state.json"))
flow=Flow.from_client_secrets_file(".secrets/oauth_client.json",scopes=SCOPES,redirect_uri="http://localhost:8765/",state=st["state"])
flow.code_verifier=st["verifier"]
flow.fetch_token(authorization_response=sys.argv[1])
open(".secrets/token.json","w").write(flow.credentials.to_json())
print("ok, refresh token:", bool(flow.credentials.refresh_token))
