import csv
import sqlite3
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = BASE_DIR / "AWESOME_AUTOPARTS.db"

SCHEMA = {
    "STORE": """
        CREATE TABLE IF NOT EXISTS STORE (
            store_id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            address TEXT NOT NULL,
            phone TEXT NOT NULL
        )
    """,
    "EMPLOYEE": """
        CREATE TABLE IF NOT EXISTS EMPLOYEE (
            employee_id INTEGER PRIMARY KEY,
            store_id INTEGER NOT NULL REFERENCES STORE(store_id),
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT NOT NULL,
            department TEXT NOT NULL,
            role TEXT NOT NULL,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            hire_date TEXT NOT NULL
        )
    """,
    "CUSTOMER": """
        CREATE TABLE IF NOT EXISTS CUSTOMER (
            customer_id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            phone TEXT,
            address TEXT,
            preferred_store_id INTEGER REFERENCES STORE(store_id),
            car_make TEXT,
            car_model TEXT,
            car_year INTEGER,
            username TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """,
    "PART": """
        CREATE TABLE IF NOT EXISTS PART (
            part_number TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            brand TEXT NOT NULL,
            category TEXT NOT NULL,
            condition TEXT NOT NULL,
            price NUMERIC NOT NULL CHECK (price >= 0),
            description TEXT
        )
    """,
    "INVENTORY": """
        CREATE TABLE IF NOT EXISTS INVENTORY (
            store_id INTEGER NOT NULL REFERENCES STORE(store_id),
            part_number TEXT NOT NULL REFERENCES PART(part_number),
            quantity INTEGER NOT NULL CHECK (quantity >= 0),
            reorder_level INTEGER NOT NULL CHECK (reorder_level >= 0),
            PRIMARY KEY (store_id, part_number)
        )
    """,
    "CUSTOMER_ORDER": """
        CREATE TABLE IF NOT EXISTS CUSTOMER_ORDER (
            order_id INTEGER PRIMARY KEY,
            customer_id INTEGER NOT NULL REFERENCES CUSTOMER(customer_id),
            store_id INTEGER NOT NULL REFERENCES STORE(store_id),
            order_date TEXT NOT NULL,
            payment_method TEXT NOT NULL,
            billing_address TEXT,
            total_amount NUMERIC NOT NULL CHECK (total_amount >= 0),
            card_type TEXT,
            delivery_address TEXT
        )
    """,
    "ORDER_ITEM": """
        CREATE TABLE IF NOT EXISTS ORDER_ITEM (
            order_id INTEGER NOT NULL REFERENCES CUSTOMER_ORDER(order_id),
            part_number TEXT NOT NULL REFERENCES PART(part_number),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price NUMERIC NOT NULL CHECK (unit_price >= 0),
            PRIMARY KEY (order_id, part_number)
        )
    """,
    "PURCHASE_ORDER": """
        CREATE TABLE IF NOT EXISTS PURCHASE_ORDER (
            po_id INTEGER PRIMARY KEY,
            store_id INTEGER NOT NULL REFERENCES STORE(store_id),
            employee_id INTEGER NOT NULL REFERENCES EMPLOYEE(employee_id),
            supplier_name TEXT NOT NULL,
            order_date TEXT NOT NULL,
            expected_date TEXT
        )
    """,
    "PO_LINE": """
        CREATE TABLE IF NOT EXISTS PO_LINE (
            po_id INTEGER NOT NULL REFERENCES PURCHASE_ORDER(po_id),
            part_number TEXT NOT NULL REFERENCES PART(part_number),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_cost NUMERIC NOT NULL CHECK (unit_cost >= 0),
            PRIMARY KEY (po_id, part_number)
        )
    """,
}

COLUMN_TYPES = {
    "store_id": int,
    "employee_id": int,
    "customer_id": int,
    "part_number": str,
    "name": str,
    "address": str,
    "phone": str,
    "email": str,
    "department": str,
    "role": str,
    "username": str,
    "password_hash": str,
    "hire_date": str,
    "preferred_store_id": int,
    "car_make": str,
    "car_model": str,
    "car_year": int,
    "created_at": str,
    "brand": str,
    "category": str,
    "condition": str,
    "price": float,
    "description": str,
    "quantity": int,
    "reorder_level": int,
    "order_id": int,
    "order_date": str,
    "payment_method": str,
    "billing_address": str,
    "total_amount": float,
    "card_type": str,
    "delivery_address": str,
    "unit_price": float,
    "po_id": int,
    "supplier_name": str,
    "expected_date": str,
    "unit_cost": float,
}

DELETE_ORDER = (
    "PO_LINE",
    "ORDER_ITEM",
    "INVENTORY",
    "PURCHASE_ORDER",
    "CUSTOMER_ORDER",
    "EMPLOYEE",
    "CUSTOMER",
    "PART",
    "STORE",
)


def read_csv_rows(table_name: str) -> tuple[list[str], list[tuple]]:
    csv_path = BASE_DIR / f"{table_name}.csv"
    with csv_path.open(encoding="utf-8-sig", newline="") as csv_file:
        reader = csv.DictReader(csv_file)
        columns = reader.fieldnames
        if columns is None:
            raise ValueError(f"{csv_path.name} is missing a header row.")

        rows = []
        for line_number, row in enumerate(reader, start=2):
            values = []
            for column in columns:
                value = row[column]
                if value is None:
                    raise ValueError(
                        f"{csv_path.name}:{line_number} has an incomplete row."
                    )
                value = value.strip()
                if value == "":
                    values.append(None)
                else:
                    try:
                        values.append(COLUMN_TYPES[column](value))
                    except (KeyError, ValueError) as error:
                        raise ValueError(
                            f"Invalid {column} value in "
                            f"{csv_path.name}:{line_number}: {value!r}"
                        ) from error
            rows.append(tuple(values))

    return columns, rows


def import_sample_data() -> None:
    connection = sqlite3.connect(DATABASE_PATH)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        with connection:
            for statement in SCHEMA.values():
                connection.execute(statement)

            for table_name in DELETE_ORDER:
                connection.execute(f"DELETE FROM {table_name}")

            for table_name in SCHEMA:
                columns, rows = read_csv_rows(table_name)
                expected_columns = [
                    row[1]
                    for row in connection.execute(
                        f"PRAGMA table_info({table_name})"
                    )
                ]
                if columns != expected_columns:
                    raise ValueError(
                        f"{table_name}.csv columns {columns} do not match "
                        f"the table schema {expected_columns}."
                    )
                placeholders = ", ".join("?" for _ in columns)
                column_list = ", ".join(columns)
                connection.executemany(
                    f"INSERT INTO {table_name} ({column_list}) "
                    f"VALUES ({placeholders})",
                    rows,
                )
                print(f"Imported {len(rows)} rows into {table_name}.")
    finally:
        connection.close()


if __name__ == "__main__":
    import_sample_data()
