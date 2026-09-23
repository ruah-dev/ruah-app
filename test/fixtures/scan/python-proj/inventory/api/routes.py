from inventory.db.session import get_session
from ..core import pricing

app = (get_session, pricing)
