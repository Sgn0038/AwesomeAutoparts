"""Awesome Autoparts REST API.

Run from the project root:
    .venv\\Scripts\\python.exe -m api.app
"""

import hmac
import sqlite3
from datetime import date, datetime

from flask import Flask, jsonify, request
from flask_cors import CORS

from .db import PROJECT_ROOT, close_db, get_db, hash_password, query_all, query_one

WEB_DIR = PROJECT_ROOT / "web"

# The demo website in /web is served at "/", the JSON API under "/api".
app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")
CORS(app)  # also allow a website hosted on another origin to call this API
app.teardown_appcontext(close_db)


@app.get("/")
def index():
    return app.send_static_file("index.html")

# Columns safe to send to the browser (never password_hash).
CUSTOMER_COLS = (
    "customer_id, name, email, phone, address, preferred_store_id, "
    "car_make, car_model, car_year, username, created_at"
)
EMPLOYEE_COLS = (
    "employee_id, store_id, name, email, phone, department, role, "
    "username, hire_date"
)


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def handle_api_error(error: ApiError):
    return jsonify({"error": error.message}), error.status


@app.errorhandler(404)
def handle_404(_error):
    return jsonify({"error": "Not found"}), 404


def require_json(*fields: str) -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Request body must be a JSON object")
    missing = [f for f in fields if data.get(f) in (None, "")]
    if missing:
        raise ApiError(f"Missing required field(s): {', '.join(missing)}")
    return data


def found(row, what: str):
    if row is None:
        raise ApiError(f"{what} not found", 404)
    return jsonify(row)


# --------------------------------------------------------------------- health
@app.get("/api/health")
def health():
    get_db().execute("SELECT 1")
    return jsonify({"status": "ok"})


# --------------------------------------------------------------------- stores
@app.get("/api/stores")
def list_stores():
    return jsonify(query_all("SELECT * FROM STORE ORDER BY store_id"))


@app.get("/api/stores/<int:store_id>")
def get_store(store_id: int):
    return found(
        query_one("SELECT * FROM STORE WHERE store_id = ?", (store_id,)), "Store"
    )


@app.get("/api/stores/<int:store_id>/inventory")
def store_inventory(store_id: int):
    """Parts stocked at a store. ?low_stock=true limits to items at/below reorder level."""
    sql = """
        SELECT p.*, i.quantity, i.reorder_level,
               i.quantity <= i.reorder_level AS needs_reorder
        FROM INVENTORY i JOIN PART p ON p.part_number = i.part_number
        WHERE i.store_id = ?
    """
    if request.args.get("low_stock", "").lower() == "true":
        sql += " AND i.quantity <= i.reorder_level"
    return jsonify(query_all(sql + " ORDER BY p.category, p.name", (store_id,)))


@app.patch("/api/stores/<int:store_id>/inventory/<part_number>")
def update_inventory(store_id: int, part_number: str):
    """Body: {quantity?, reorder_level?} — used by the employee inventory manager."""
    data = require_json()
    updates = {k: data[k] for k in ("quantity", "reorder_level") if k in data}
    if not updates:
        raise ApiError("Provide quantity and/or reorder_level")
    try:
        values = {k: int(v) for k, v in updates.items()}
    except (TypeError, ValueError) as error:
        raise ApiError("quantity and reorder_level must be whole numbers") from error
    if any(v < 0 for v in values.values()):
        raise ApiError("Values cannot be negative")

    db = get_db()
    assignments = ", ".join(f"{k} = ?" for k in values)
    with db:
        cur = db.execute(
            f"UPDATE INVENTORY SET {assignments} WHERE store_id = ? AND part_number = ?",
            (*values.values(), store_id, part_number),
        )
    if cur.rowcount == 0:
        raise ApiError("Inventory record not found", 404)
    return jsonify(
        query_one(
            "SELECT * FROM INVENTORY WHERE store_id = ? AND part_number = ?",
            (store_id, part_number),
        )
    )


# ---------------------------------------------------------------------- parts
@app.get("/api/parts")
def list_parts():
    """Catalog search. Optional filters: q, category, brand, condition,
    min_price, max_price, store_id (only parts in stock at that store)."""
    clauses, params = [], []
    if q := request.args.get("q"):
        clauses.append("(p.name LIKE ? OR p.description LIKE ? OR p.part_number LIKE ?)")
        params += [f"%{q}%"] * 3
    for col in ("category", "brand", "condition"):
        if value := request.args.get(col):
            clauses.append(f"p.{col} = ?")
            params.append(value)
    if (lo := request.args.get("min_price", type=float)) is not None:
        clauses.append("p.price >= ?")
        params.append(lo)
    if (hi := request.args.get("max_price", type=float)) is not None:
        clauses.append("p.price <= ?")
        params.append(hi)
    if (store_id := request.args.get("store_id", type=int)) is not None:
        clauses.append(
            "EXISTS (SELECT 1 FROM INVENTORY i WHERE i.part_number = p.part_number "
            "AND i.store_id = ? AND i.quantity > 0)"
        )
        params.append(store_id)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return jsonify(
        query_all(f"SELECT p.* FROM PART p {where} ORDER BY p.category, p.name", tuple(params))
    )


@app.get("/api/parts/categories")
def list_categories():
    rows = query_all("SELECT DISTINCT category FROM PART ORDER BY category")
    return jsonify([r["category"] for r in rows])


@app.get("/api/parts/brands")
def list_brands():
    rows = query_all("SELECT DISTINCT brand FROM PART ORDER BY brand")
    return jsonify([r["brand"] for r in rows])


@app.get("/api/parts/<part_number>")
def get_part(part_number: str):
    part = query_one("SELECT * FROM PART WHERE part_number = ?", (part_number,))
    if part is None:
        raise ApiError("Part not found", 404)
    part["availability"] = query_all(
        """
        SELECT s.store_id, s.name AS store_name, i.quantity
        FROM INVENTORY i JOIN STORE s ON s.store_id = i.store_id
        WHERE i.part_number = ? ORDER BY s.store_id
        """,
        (part_number,),
    )
    return jsonify(part)


# ----------------------------------------------------------------------- auth
@app.post("/api/login")
def login():
    """Body: {username, password, type: "customer" | "employee"}."""
    data = require_json("username", "password")
    kind = data.get("type", "customer")
    if kind == "customer":
        table, cols = "CUSTOMER", CUSTOMER_COLS
    elif kind == "employee":
        table, cols = "EMPLOYEE", EMPLOYEE_COLS
    else:
        raise ApiError("type must be 'customer' or 'employee'")

    row = query_one(
        f"SELECT {cols}, password_hash FROM {table} WHERE username = ?",
        (data["username"],),
    )
    if row is None or not hmac.compare_digest(
        row.pop("password_hash"), hash_password(data["password"])
    ):
        raise ApiError("Invalid username or password", 401)
    return jsonify({"type": kind, "user": row})


# ------------------------------------------------------------------ customers
@app.post("/api/customers")
def register_customer():
    data = require_json(
        "name", "email", "phone", "address", "preferred_store_id",
        "car_make", "car_model", "car_year", "username", "password",
    )
    db = get_db()
    if query_one("SELECT 1 FROM CUSTOMER WHERE username = ?", (data["username"],)):
        raise ApiError("Username already taken", 409)
    try:
        with db:
            cur = db.execute(
                """
                INSERT INTO CUSTOMER (name, email, phone, address, preferred_store_id,
                    car_make, car_model, car_year, username, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data["name"], data["email"], data["phone"], data["address"],
                    int(data["preferred_store_id"]), data["car_make"],
                    data["car_model"], int(data["car_year"]), data["username"],
                    hash_password(data["password"]),
                    datetime.now().isoformat(timespec="seconds"),
                ),
            )
    except (ValueError, sqlite3.IntegrityError) as error:
        raise ApiError(f"Invalid customer data: {error}") from error
    customer = query_one(
        f"SELECT {CUSTOMER_COLS} FROM CUSTOMER WHERE customer_id = ?", (cur.lastrowid,)
    )
    return jsonify(customer), 201


@app.get("/api/customers/<int:customer_id>")
def get_customer(customer_id: int):
    return found(
        query_one(
            f"SELECT {CUSTOMER_COLS} FROM CUSTOMER WHERE customer_id = ?", (customer_id,)
        ),
        "Customer",
    )


@app.get("/api/customers/<int:customer_id>/orders")
def customer_orders(customer_id: int):
    return jsonify(
        query_all(
            """
            SELECT o.*, s.name AS store_name,
                   (SELECT COUNT(*) FROM ORDER_ITEM oi WHERE oi.order_id = o.order_id) AS item_count
            FROM CUSTOMER_ORDER o JOIN STORE s ON s.store_id = o.store_id
            WHERE o.customer_id = ? ORDER BY o.order_date DESC, o.order_id DESC
            """,
            (customer_id,),
        )
    )


@app.get("/api/customers/<int:customer_id>/recommended-parts")
def recommended_parts(customer_id: int):
    """Parts in stock at the customer's preferred store."""
    customer = query_one(
        "SELECT preferred_store_id FROM CUSTOMER WHERE customer_id = ?", (customer_id,)
    )
    if customer is None:
        raise ApiError("Customer not found", 404)
    return jsonify(
        query_all(
            """
            SELECT p.*, i.quantity FROM INVENTORY i
            JOIN PART p ON p.part_number = i.part_number
            WHERE i.store_id = ? AND i.quantity > 0 ORDER BY p.category, p.name
            """,
            (customer["preferred_store_id"],),
        )
    )


# --------------------------------------------------------------------- orders
def order_with_items(order_id: int) -> dict | None:
    order = query_one(
        """
        SELECT o.*, s.name AS store_name, c.name AS customer_name
        FROM CUSTOMER_ORDER o
        JOIN STORE s ON s.store_id = o.store_id
        JOIN CUSTOMER c ON c.customer_id = o.customer_id
        WHERE o.order_id = ?
        """,
        (order_id,),
    )
    if order is not None:
        order["items"] = query_all(
            """
            SELECT oi.part_number, p.name, p.brand, oi.quantity, oi.unit_price,
                   ROUND(oi.quantity * oi.unit_price, 2) AS line_total
            FROM ORDER_ITEM oi JOIN PART p ON p.part_number = oi.part_number
            WHERE oi.order_id = ?
            """,
            (order_id,),
        )
    return order


@app.get("/api/orders")
def list_orders():
    """Optional filters: store_id, customer_id."""
    clauses, params = [], []
    for col in ("store_id", "customer_id"):
        if (value := request.args.get(col, type=int)) is not None:
            clauses.append(f"o.{col} = ?")
            params.append(value)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return jsonify(
        query_all(
            f"""
            SELECT o.*, c.name AS customer_name, s.name AS store_name
            FROM CUSTOMER_ORDER o
            JOIN CUSTOMER c ON c.customer_id = o.customer_id
            JOIN STORE s ON s.store_id = o.store_id
            {where} ORDER BY o.order_date DESC, o.order_id DESC
            """,
            tuple(params),
        )
    )


@app.get("/api/orders/<int:order_id>")
def get_order(order_id: int):
    return found(order_with_items(order_id), "Order")


@app.post("/api/orders")
def create_order():
    """Body: {customer_id, store_id, payment_method, billing_address,
    card_type?, delivery_address?, items: [{part_number, quantity}, ...]}

    Prices come from the PART table (never trust a price sent by the browser)
    and stock is taken from the chosen store's INVENTORY in one transaction.
    """
    data = require_json(
        "customer_id", "store_id", "payment_method", "billing_address", "items"
    )
    items = data["items"]
    if not isinstance(items, list) or not items:
        raise ApiError("items must be a non-empty list")

    db = get_db()
    store_id = int(data["store_id"])
    total = 0.0
    line_items = []
    try:
        with db:  # commits on success, rolls back if anything raises
            for item in items:
                part_number = item.get("part_number")
                quantity = int(item.get("quantity", 0))
                if quantity <= 0:
                    raise ApiError(f"Quantity for {part_number} must be positive")

                part = db.execute(
                    "SELECT price FROM PART WHERE part_number = ?", (part_number,)
                ).fetchone()
                if part is None:
                    raise ApiError(f"Part {part_number} not found", 404)
                stock = db.execute(
                    "SELECT quantity FROM INVENTORY WHERE store_id = ? AND part_number = ?",
                    (store_id, part_number),
                ).fetchone()
                if stock is None:
                    raise ApiError(f"Store {store_id} does not carry {part_number}", 404)

                # Conditional UPDATE: only succeeds if enough stock remains,
                # so two simultaneous orders can't both take the last unit.
                cur = db.execute(
                    "UPDATE INVENTORY SET quantity = quantity - ? "
                    "WHERE store_id = ? AND part_number = ? AND quantity >= ?",
                    (quantity, store_id, part_number, quantity),
                )
                if cur.rowcount == 0:
                    raise ApiError(
                        f"Not enough stock for {part_number}: requested {quantity}, "
                        f"{stock['quantity']} available",
                        409,
                    )

                line_items.append((part_number, quantity, part["price"]))
                total += quantity * part["price"]

            cur = db.execute(
                """
                INSERT INTO CUSTOMER_ORDER (customer_id, store_id, order_date,
                    payment_method, billing_address, total_amount, card_type,
                    delivery_address)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(data["customer_id"]), store_id, date.today().isoformat(),
                    data["payment_method"], data["billing_address"], round(total, 2),
                    data.get("card_type"), data.get("delivery_address"),
                ),
            )
            order_id = cur.lastrowid
            db.executemany(
                "INSERT INTO ORDER_ITEM (order_id, part_number, quantity, unit_price) "
                "VALUES (?, ?, ?, ?)",
                [(order_id, *line) for line in line_items],
            )
    except (ValueError, TypeError, sqlite3.IntegrityError) as error:
        raise ApiError(f"Invalid order: {error}") from error
    return jsonify(order_with_items(order_id)), 201


# ------------------------------------------------------------ employees / POs
@app.get("/api/employees")
def list_employees():
    """Optional filter: store_id."""
    if (store_id := request.args.get("store_id", type=int)) is not None:
        return jsonify(
            query_all(
                f"SELECT {EMPLOYEE_COLS} FROM EMPLOYEE WHERE store_id = ? ORDER BY name",
                (store_id,),
            )
        )
    return jsonify(query_all(f"SELECT {EMPLOYEE_COLS} FROM EMPLOYEE ORDER BY store_id, name"))


@app.get("/api/employees/<int:employee_id>")
def get_employee(employee_id: int):
    return found(
        query_one(
            f"SELECT {EMPLOYEE_COLS} FROM EMPLOYEE WHERE employee_id = ?", (employee_id,)
        ),
        "Employee",
    )


@app.get("/api/purchase-orders")
def list_purchase_orders():
    """Optional filter: store_id."""
    clause, params = "", ()
    if (store_id := request.args.get("store_id", type=int)) is not None:
        clause, params = "WHERE po.store_id = ?", (store_id,)
    return jsonify(
        query_all(
            f"""
            SELECT po.*, e.name AS employee_name, s.name AS store_name,
                   ROUND(COALESCE(SUM(l.quantity * l.unit_cost), 0), 2) AS total_cost
            FROM PURCHASE_ORDER po
            JOIN EMPLOYEE e ON e.employee_id = po.employee_id
            JOIN STORE s ON s.store_id = po.store_id
            LEFT JOIN PO_LINE l ON l.po_id = po.po_id
            {clause}
            GROUP BY po.po_id ORDER BY po.order_date DESC
            """,
            params,
        )
    )


@app.get("/api/purchase-orders/<int:po_id>")
def get_purchase_order(po_id: int):
    po = query_one(
        """
        SELECT po.*, e.name AS employee_name, s.name AS store_name
        FROM PURCHASE_ORDER po
        JOIN EMPLOYEE e ON e.employee_id = po.employee_id
        JOIN STORE s ON s.store_id = po.store_id
        WHERE po.po_id = ?
        """,
        (po_id,),
    )
    if po is None:
        raise ApiError("Purchase order not found", 404)
    po["lines"] = query_all(
        """
        SELECT l.part_number, p.name, l.quantity, l.unit_cost,
               ROUND(l.quantity * l.unit_cost, 2) AS line_total
        FROM PO_LINE l JOIN PART p ON p.part_number = l.part_number
        WHERE l.po_id = ?
        """,
        (po_id,),
    )
    return jsonify(po)


# -------------------------------------------------------------------- reports
@app.get("/api/reports/summary")
def report_summary():
    """Dashboard numbers for employee mode. Optional filter: store_id."""
    store_id = request.args.get("store_id", type=int)
    order_where = "WHERE o.store_id = ?" if store_id else ""
    params = (store_id,) if store_id else ()

    totals = query_one(
        f"""
        SELECT COUNT(*) AS order_count,
               ROUND(COALESCE(SUM(o.total_amount), 0), 2) AS revenue,
               ROUND(COALESCE(AVG(o.total_amount), 0), 2) AS average_order,
               COUNT(DISTINCT o.customer_id) AS customers
        FROM CUSTOMER_ORDER o {order_where}
        """,
        params,
    )
    totals["low_stock_items"] = query_one(
        "SELECT COUNT(*) AS n FROM INVENTORY WHERE quantity <= reorder_level"
        + (" AND store_id = ?" if store_id else ""),
        params,
    )["n"]

    return jsonify(
        {
            "totals": totals,
            "by_store": query_all(
                """
                SELECT s.store_id, s.name,
                       COUNT(o.order_id) AS order_count,
                       ROUND(COALESCE(SUM(o.total_amount), 0), 2) AS revenue
                FROM STORE s LEFT JOIN CUSTOMER_ORDER o ON o.store_id = s.store_id
                GROUP BY s.store_id ORDER BY revenue DESC
                """
            ),
            "by_month": query_all(
                f"""
                SELECT substr(o.order_date, 1, 7) AS month, COUNT(*) AS order_count,
                       ROUND(SUM(o.total_amount), 2) AS revenue
                FROM CUSTOMER_ORDER o {order_where}
                GROUP BY month ORDER BY month
                """,
                params,
            ),
            "top_parts": query_all(
                f"""
                SELECT p.part_number, p.name, p.category,
                       SUM(oi.quantity) AS units_sold,
                       ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue
                FROM ORDER_ITEM oi
                JOIN PART p ON p.part_number = oi.part_number
                JOIN CUSTOMER_ORDER o ON o.order_id = oi.order_id
                {order_where}
                GROUP BY p.part_number ORDER BY units_sold DESC, revenue DESC LIMIT 5
                """,
                params,
            ),
            "by_payment": query_all(
                f"""
                SELECT o.payment_method, COUNT(*) AS order_count,
                       ROUND(SUM(o.total_amount), 2) AS revenue
                FROM CUSTOMER_ORDER o {order_where}
                GROUP BY o.payment_method ORDER BY revenue DESC
                """,
                params,
            ),
        }
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
