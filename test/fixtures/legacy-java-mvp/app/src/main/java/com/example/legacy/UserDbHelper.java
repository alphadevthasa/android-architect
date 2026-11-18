package com.example.legacy;

import android.database.sqlite.SQLiteOpenHelper;

public abstract class UserDbHelper extends SQLiteOpenHelper {
    UserDbHelper(android.content.Context context) {
        super(context, "users.db", null, 1);
    }
}
