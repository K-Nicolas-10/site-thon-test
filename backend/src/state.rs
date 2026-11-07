use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::ab::AbData;
use crate::catalog::Product;

#[derive(Clone)]
pub struct AppState {
    pub frontend_dir: PathBuf,
    pub inner: std::sync::Arc<Inner>,
}

pub struct Inner {
    /// Testing-grounds plumbing. Owns no experiment decisions.
    pub ab: Mutex<AbData>,
    pub catalog: Vec<Product>,
    pub carts: Mutex<HashMap<String, Cart>>,
    pub orders: Mutex<Vec<Order>>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Cart {
    pub lines: Vec<CartLine>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CartLine {
    pub product_id: String,
    pub qty: u32,
}

#[derive(Clone, Serialize)]
pub struct Order {
    pub id: String,
    pub items: Vec<OrderItem>,
    pub total_cents: u64,
    pub email: String,
    pub created_at: String,
}

#[derive(Clone, Serialize)]
pub struct OrderItem {
    pub product_id: String,
    pub name: String,
    pub qty: u32,
    pub unit_price_cents: u64,
}

impl AppState {
    pub fn new(frontend_dir: PathBuf, data_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&data_dir);
        Self {
            frontend_dir,
            inner: std::sync::Arc::new(Inner {
                ab: Mutex::new(AbData::load(&data_dir)),
                catalog: crate::catalog::seed(),
                carts: Mutex::new(HashMap::new()),
                orders: Mutex::new(Vec::new()),
            }),
        }
    }
}
