package com.example.modern.core.data

import androidx.room.Dao
import androidx.room.Query

@Dao
interface UserDao {
    @Query("SELECT name FROM user")
    fun names(): List<String>
}
