drop procedure if exists select_layers_weightedrandom;
delimiter //
create procedure select_layers_weightedrandom(
    in p_view varchar(1000),
    in iterations int
)
begin
    declare done int default false;
    declare colname varchar(255);
    declare column_ordinal int;
    declare col_cursor cursor for
        select columnName, ordinal
        from genLayerColumnOrder
        order by ordinal;
    declare continue handler for not found set done = true;

    drop temporary table if exists weights_map;
    create temporary table weights_map
    (
        value  varchar(255) collate utf8mb4_0900_ai_ci,
        weight float
    ) collate utf8mb4_0900_ai_ci;

    drop temporary table if exists results;
    create temporary table results
    (
        id varchar(255) collate utf8mb4_0900_ai_ci
    ) collate utf8mb4_0900_ai_ci;

    drop temporary table if exists selected_values;
    create temporary table selected_values
    (
        columnName varchar(255) collate utf8mb4_0900_ai_ci,
        value      varchar(255) collate utf8mb4_0900_ai_ci
    );

-- #     drop temporary table if exists dbg;
-- #     create temporary table if not exists dbg
-- #     (
-- #         msg varchar(2048) collate utf8mb4_0900_ai_ci
-- #     ) collate utf8mb4_0900_ai_ci;

    -- loop for num_layers times
    while iterations > 0
        do
            truncate table selected_values;
            -- process each column in order
            open col_cursor;
            col_loop:
            loop
                fetch col_cursor into colname, column_ordinal;
-- #                 insert into dbg (msg) values (concat('Processing column: ', coalesce(colname, '<empty>')));
                if done then
                    leave col_loop;
                end if;

                truncate table weights_map;

                set @selected_condition = null;
                select group_concat(concat(columnName, ' = ''', value, ''' collate utf8mb4_0900_ai_ci') separator
                                    ' and ')
                into @selected_condition
                from selected_values;
                if @selected_condition is null then
                    set @selected_condition = '1=1';
                end if;

                set @sql = concat('insert into weights_map (
                    select vals.value as value,
                           coalesce(weights.weight, 1) as weight
                    from (select distinct ', colname, ' as value from ', p_view, ' where ', @selected_condition, ') vals
                    left join genLayerWeights weights
                          on weights.value = vals.value collate utf8mb4_0900_ai_ci and weights.columnName = ''',
                                  colname, ''' collate utf8mb4_0900_ai_ci)');

-- #                 insert into dbg (msg) values (concat('SQL: ', @sql));
                prepare stmt from @sql;
                execute stmt;
                deallocate prepare stmt;

                set @values_count = 0;
                select count(*) into @values_count from weights_map;

                if @values_count = 0 then
-- #                     insert into dbg (msg) values (concat('Unable to resolve weights for column: ', coalesce(colname, '<empty>')));
                    leave col_loop;
                elseif @values_count = 1 then
                    set @selected_value = (select value from weights_map);
                else
                    set @selected_value = select_from_weights_map();
                    if @selected_value is null then
-- #                         insert into dbg (msg) values (concat('No value found for column: ', coalesce(colname, '<empty>')));
                        leave col_loop;
                    end if;
                end if;

-- #                 insert into dbg (msg) values (concat('Selected value: ', coalesce(@selected_value, '<empty>')));
                insert into selected_values (columnName, value) values (colname, @selected_value);
            end loop;
            close col_cursor;
            set done = false;
            -- reset for next iteration

            set @selected_condition = '1=1';
            select group_concat(concat(columnName, ' = ''', value, ''' collate utf8mb4_0900_ai_ci') separator ' and ')
            into @selected_condition
            from selected_values;
            set @selected_id = null;
            set @sql = concat('select id into @selected_id from ', p_view, ' l where ',
                              @selected_condition,
                              ' order by rand() limit 1');

            prepare stmt from @sql;
            execute stmt;
            deallocate prepare stmt;
#
            if @selected_id is not null then
                insert into results (id) values (@selected_id);
-- #                 insert into dbg (msg) values (concat('Selected ID: ', @selected_id));
            end if;
            set iterations = iterations - 1;
        end while;

    select id from results;
end //
delimiter ;

delimiter //
drop function if exists select_from_weights_map;
create function select_from_weights_map()
    returns varchar(255)
    reads sql data
begin
    declare done int default false;
    declare curr_weight float;
    declare curr_value varchar(255);
    declare cum_weight float;
    declare target_weight float;
    declare total_weight float;
    declare weight_cursor cursor for select weight, value from weights_map;
    declare continue handler for not found set done = true;

    select sum(weight) into total_weight from weights_map;

    set target_weight = rand() * total_weight;
-- #     insert into dbg (msg) values (concat('Target weight: ', target_weight));

    set curr_weight = 0;
    set cum_weight = 0;
    open weight_cursor;

    weight_loop:
    loop
        fetch weight_cursor into curr_weight, curr_value;
        if done then
            leave weight_loop;
        end if;
        set cum_weight = curr_weight + cum_weight;
        if cum_weight >= target_weight then
            return curr_value;
        end if;
    end loop;

    return null;
end;
